import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { lock } from "proper-lockfile";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { atomicWrite } from "./store.js";
import { emptyTokens, QuotaSchema, type Harness, type Quota, type ResetOutcome, type TokenTotals, type UsageCounter } from "../shared/accounts.js";

export const emptyCounter = (): UsageCounter => ({ totals: emptyTokens(), observed: false, complete: true });
const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const unavailableQuota = (error: string | null = null): Quota =>
  ({ status: "unavailable", windows: [], plan: null, fetchedAt: null, error, resetCredits: null });
export class QuotaError extends Error {
  constructor(public status: "auth-required" | "error" | "unavailable", message: string, public retryAfterMs = 60000) { super(message); }
}
export function applicableQuotaWindows(quota: Quota, model: string | null) {
  return quota.windows.filter(w => !w.scope || !model || model.toLowerCase().includes(w.scope.toLowerCase()) ||
    !/opus|sonnet|haiku|gpt|review|spark|image/i.test(w.scope));
}
export function hasRemainingQuota(quota: Quota, model: string | null) {
  const windows = applicableQuotaWindows(quota, model);
  return quota.status === "available" && !quota.error && windows.length > 0 &&
    windows.every(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent < 100);
}

/** Only account metadata RPCs; no threads, prompts, OAuth start, or external token injection. */
async function codexAccount<T>(command: string, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined, credentialArgs: string[],
  operation: (request: (method: string, params?: unknown) => Promise<any>, account: any) => Promise<T>, recoverAuth = true): Promise<T> {
  const child = spawn(command, ["app-server", ...credentialArgs], { env, shell: false, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  const fail = () => {
    for (const request of pending.values()) request.reject(new QuotaError("error", "Codex 한도를 조회하지 못했습니다. 설치와 로그인을 확인한 뒤 새로고침하세요."));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  const reader = createInterface({ input: child.stdout });
  reader.on("line", line => {
    if (line.length > 1024 * 1024) { fail(); child.kill(); return; }
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (typeof value.method === "string") return;
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    if (value.error) {
      const code = value.error.code;
      const auth = code === 401 || /\b401\b|unauthorized|not authenticated|not logged in|(?:refresh|access)[ _-]?token[^\n]{0,60}(?:expired|revoked|reused)/i.test(String(value.error.message));
      request.reject(new QuotaError(auth ? "auth-required" : code === -32601 ? "unavailable" : "error",
        auth ? "한도 조회에 다시 로그인이 필요합니다." : code === -32601 ? "이 Codex 버전은 한도 조회를 지원하지 않습니다." : "Codex 한도를 조회하지 못했습니다. 잠시 후 새로고침하세요."));
    } else request.resolve(value.result);
  });
  const abort = () => { fail(); child.kill("SIGTERM"); };
  const timer = setTimeout(abort, 30000);
  signal?.addEventListener("abort", abort, { once: true });
  const request = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    if (signal?.aborted || child.exitCode !== null) { reject(new QuotaError("error", "한도 조회가 중단되었습니다.")); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "paseo-account-usage", version: "1.1.0" }, capabilities: {} });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const run = async (refreshToken: boolean) => {
      const auth = await request("account/read", { refreshToken });
      if (!auth.account) throw new QuotaError("auth-required", "저장된 인증을 복구하지 못했습니다. 다시 로그인하세요.");
      if (auth.account.type !== "chatgpt") throw new QuotaError("unavailable", "이 인증 방식은 구독 한도를 제공하지 않습니다.");
      return operation(request, auth.account);
    };
    try { return await run(false); }
    catch (error) {
      if (!recoverAuth || !(error instanceof QuotaError) || error.status !== "auth-required") throw error;
      return await run(true);
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort); reader.close();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000); kill.unref();
      child.once("exit", () => clearTimeout(kill));
    }
  }
}
export function codexQuota(command: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, credentialArgs: string[] = []): Promise<Quota> {
  return codexAccount(command, env, signal, credentialArgs, async (request, account) =>
    parseCodexQuota(await request("account/rateLimits/read"), account.planType));
}
export function codexConsumeReset(command: string, env: NodeJS.ProcessEnv, attemptId: string, creditId: string | null, credentialArgs: string[] = []) {
  return codexAccount(command, env, undefined, credentialArgs, async request => {
    const response = await request("account/rateLimitResetCredit/consume", { idempotencyKey: attemptId, ...(creditId ? { creditId } : {}) });
    if (!["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].includes(response?.outcome))
      throw new QuotaError("error", "리셋 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
    return response.outcome as "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";
  }, false);
}

const date = (value: unknown, seconds = false): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(seconds && typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const percent = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(100, value) : null;

export function parseCodexQuota(response: any, plan?: unknown): Quota {
  const windows: Quota["windows"] = [];
  const buckets = response?.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length
    ? Object.entries(response.rateLimitsByLimitId) : [["codex", response?.rateLimits]];
  buckets.sort(([a], [b]) => a === b ? 0 : a === "codex" ? -1 : b === "codex" ? 1 : String(a).localeCompare(String(b)));
  for (const [id, raw] of buckets) {
    const bucket = raw as any;
    for (const kind of ["primary", "secondary"]) {
      const window = bucket?.[kind], used = percent(window?.usedPercent), duration = window?.windowDurationMins;
      if (used === null || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) continue;
      const suffix = id === "codex" ? "" : ` · ${typeof bucket.limitName === "string" ? bucket.limitName : id}`;
      windows.push({ id: `${id}:${kind}`, label: (duration === 300 ? "5시간 한도" : duration === 10080 ? "주간 한도" : `${duration}분 한도`) + suffix,
        usedPercent: used, durationMinutes: duration, resetsAt: date(window.resetsAt, true), scope: id === "codex" ? null : String(id) });
    }
  }
  const raw = response?.rateLimitResetCredits;
  const resetCredits = number(raw?.availableCount) ? {
    availableCount: raw.availableCount,
    credits: Array.isArray(raw.credits) ? raw.credits.flatMap((credit: any) =>
      typeof credit?.id === "string" && credit.id.length > 0 && credit.id.length <= 512 ? [{
        id: credit.id, resetType: typeof credit.resetType === "string" ? credit.resetType : "unknown",
        status: typeof credit.status === "string" ? credit.status : "unknown",
        grantedAt: date(credit.grantedAt, true), expiresAt: date(credit.expiresAt, true),
        title: typeof credit.title === "string" ? credit.title : null,
      }] : []) : null,
  } : null;
  return QuotaSchema.parse({ status: "available", windows, resetCredits, plan: typeof plan === "string" ? plan : null,
    fetchedAt: new Date().toISOString(), error: null });
}

export function parseClaudeQuota(response: any, plan?: unknown): Quota {
  const windows: Quota["windows"] = [];
  const add = (id: string, label: string, value: any, durationMinutes = 10080, scope: string | null = null) => {
    const used = percent(value?.utilization ?? value?.percent);
    if (used !== null) windows.push({ id, label, usedPercent: used, durationMinutes, resetsAt: date(value.resets_at), scope });
  };
  add("five_hour", "5시간 한도", response?.five_hour, 300);
  add("seven_day", "주간 한도", response?.seven_day);
  for (const model of ["opus", "sonnet"]) add(`seven_day_${model}`, `주간 한도 · ${model === "opus" ? "Opus" : "Sonnet"}`, response?.[`seven_day_${model}`], 10080, model);
  if (Array.isArray(response?.limits)) for (const [i, value] of response.limits.entries()) {
    if (value?.kind !== "weekly_scoped") continue;
    const scope = value.scope?.model ?? value.scope?.surface;
    const name = typeof scope === "string" ? scope : scope?.display_name ?? scope?.id;
    if (typeof name === "string") add(`scoped:${i}`, `주간 한도 · ${name}`, value, 10080, name);
  }
  if (!response || typeof response !== "object") throw new QuotaError("error", "Claude 한도 응답을 읽지 못했습니다.");
  let resetCredits = null, resetError = null;
  if (response.cedar_ember !== undefined) {
    try { resetCredits = parseClaudeResetCredits(response.cedar_ember); }
    catch { resetError = "Claude 리셋권 응답을 읽지 못했습니다. 목록을 다시 조회하세요."; }
  } else resetError = "이 계정의 리셋권 정보를 제공하지 않았습니다.";
  return QuotaSchema.parse({ status: "available", windows, resetCredits, resetError, plan: typeof plan === "string" ? plan : null,
    fetchedAt: new Date().toISOString(), error: null });
}

// Account endpoints mirror the installed Claude Code 2.1.285 client and OpenCodex's reset-grant contract.
const CLAUDE_USAGE_PATH = "/api/oauth/usage?cedar_ember=1&skip_spend=1";
const claudeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeText = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 120) : null;
const resetReasons: Record<string, string> = {
  config_off: "현재 리셋권 제공이 중단되어 있습니다.", tier: "이 요금제는 리셋 대상이 아닙니다.",
  seat: "이 조직 좌석은 리셋 대상이 아닙니다.", mobile: "모바일 구독은 이 리셋 대상이 아닙니다.",
  surface: "이 인증 방식으로 리셋권을 조회할 수 없습니다.", cli_version: "Claude Code 버전 확인이 필요합니다.",
  no_grant: "지급된 리셋권이 없습니다.", tenure: "계정의 리셋 지급 조건을 충족하지 않았습니다.",
  other_experiment: "이 계정은 다른 지급 프로그램에 속해 있습니다.", unavailable: "현재 리셋권을 제공하지 않습니다.",
};
export function parseClaudeResetCredits(block: any): NonNullable<Quota["resetCredits"]> {
  if (!block || typeof block !== "object" || typeof block.eligible !== "boolean" ||
    block.grants !== undefined && !Array.isArray(block.grants) ||
    block.at_limit !== undefined && typeof block.at_limit !== "boolean") throw new QuotaError("error", "Claude 리셋권 응답을 읽지 못했습니다.");
  const seen = new Set<string>();
  const optionalDate = (value: unknown) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new QuotaError("error", "Claude 리셋권 날짜를 읽지 못했습니다.");
    return new Date(value).toISOString();
  };
  const reason = block.eligible ? null : resetReasons[block.ineligible_reason] ?? "현재 이 계정은 리셋 대상이 아닙니다.";
  const cooldown = optionalDate(block.cooldown_until);
  const credits = (block.grants ?? []).map((grant: any) => {
    if (!grant || typeof grant.id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(grant.id) || seen.has(grant.id) ||
      !number(grant.resets_total) || !number(grant.resets_left) || !Number.isInteger(grant.resets_total) ||
      !Number.isInteger(grant.resets_left) || grant.resets_left > grant.resets_total ||
      ["paused", "usable_now", "use_requires_limit"].some(key => grant[key] != null && typeof grant[key] !== "boolean") ||
      grant.clears != null && !Array.isArray(grant.clears)) throw new QuotaError("error", "Claude 리셋권 응답을 읽지 못했습니다.");
    seen.add(grant.id);
    const grantedAt = optionalDate(grant.starts_at), expiresAt = optionalDate(grant.ends_at);
    const blockedReason = grant.resets_left === 0 ? "이미 사용한 리셋권입니다." :
      expiresAt && Date.parse(expiresAt) <= Date.now() ? "만료된 리셋권입니다." :
      grantedAt && Date.parse(grantedAt) > Date.now() ? "아직 사용 기간이 시작되지 않았습니다." :
      reason ?? (grant.paused === true ? "이 리셋권은 일시 중지되었습니다." :
      cooldown && Date.parse(cooldown) > Date.now() ? "리셋 재사용 대기 중입니다." :
      (grant.use_requires_limit ?? true) && block.at_limit !== true ? "한도에 도달한 뒤 사용할 수 있습니다." :
      grant.usable_now !== true ? "현재 이 리셋권을 사용할 수 없습니다." : null);
    return { id: grant.id, resetType: "claudeRateLimits", status: blockedReason ? "blocked" : "available",
      grantedAt, expiresAt, title: safeText(grant.label), remaining: grant.resets_left, total: grant.resets_total,
      clears: (grant.clears ?? []).filter((value: unknown) => ["five_hour", "seven_day", "seven_day_overage_included"].includes(value as string)), blockedReason };
  });
  return { eligible: block.eligible, reason, availableCount: credits.reduce((sum: number, credit: { remaining: number; expiresAt: string | null }) =>
    sum + (credit.expiresAt && Date.parse(credit.expiresAt) <= Date.now() ? 0 : credit.remaining), 0), credits };
}
async function claudeCredentials(home: string) {
  try {
    const path = join(home, ".credentials.json"), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    return JSON.parse(await readFile(path, "utf8"));
  } catch { throw new QuotaError("unavailable", "이 계정의 한도 조회용 인증 정보를 읽을 수 없습니다."); }
}
// Same OAuth endpoint and both refresh locks as the installed Claude Code 2.1.287.
// Keep authentication renewal independent of model requests, prompts and reset redemption.
async function refreshClaude(home: string, fetchApi: typeof fetch, signal?: AbortSignal, rejectedToken?: string) {
  const initial = (await claudeCredentials(home)).claudeAiOauth;
  if (!initial?.refreshToken || rejectedToken && initial.accessToken !== rejectedToken ||
    !rejectedToken && !(typeof initial.expiresAt === "number" && initial.expiresAt <= Date.now() + 120000)) return initial;
  const releases: (() => Promise<void>)[] = [];
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, 20000);
  signal?.addEventListener("abort", abort, { once: true });
  let compromised = false;
  try {
    const stat = await lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error();
    const legacy = (await realpath(home)) + ".lock";
    for (const [target, path] of [[home, join(home, ".oauth_refresh.lock")], [legacy, legacy]])
      releases.push(await lock(target, { lockfilePath: path, realpath: false, stale: 60000, update: 5000,
        retries: { retries: 5, minTimeout: 200, maxTimeout: 1000 }, onCompromised: () => { compromised = true; abort(); } }));
    const current = (await claudeCredentials(home)).claudeAiOauth;
    if (current?.accessToken !== initial.accessToken || current?.refreshToken !== initial.refreshToken) return current;
    if (signal?.aborted || controller.signal.aborted) throw Error();
    const response = await fetchApi("https://platform.claude.com/v1/oauth/token", {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: current.refreshToken,
        client_id: current.clientId ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e", ...(Array.isArray(current.scopes) && current.scopes.length ? { scope: current.scopes.join(" ") } : {}) }),
    });
    let tokens: any;
    try { tokens = await response.json(); } catch { throw Error(); }
    const latest = await claudeCredentials(home);
    if (latest.claudeAiOauth?.accessToken !== current.accessToken || latest.claudeAiOauth?.refreshToken !== current.refreshToken)
      return latest.claudeAiOauth;
    if (!response.ok) {
      if (tokens?.error === "invalid_grant") throw new QuotaError("auth-required", "인증 자동 갱신으로 복구하지 못했습니다. 이 계정에 다시 로그인하세요.", 300000);
      throw Error();
    }
    if (compromised || signal?.aborted || controller.signal.aborted || typeof tokens?.access_token !== "string" || !tokens.access_token ||
      typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
      tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== "string" || !tokens.refresh_token)) throw Error();
    latest.claudeAiOauth = { ...latest.claudeAiOauth, accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? current.refreshToken, expiresAt: Date.now() + tokens.expires_in * 1000,
      refreshTokenExpiresAt: typeof tokens.refresh_token_expires_in === "number" && tokens.refresh_token_expires_in > 0
        ? Date.now() + tokens.refresh_token_expires_in * 1000 : undefined,
      ...(typeof tokens.scope === "string" ? { scopes: tokens.scope.split(/\s+/).filter(Boolean) } : {}) };
    await atomicWrite(join(home, ".credentials.json"), JSON.stringify(latest));
    return latest.claudeAiOauth;
  } catch (error) {
    if (error instanceof QuotaError) throw error;
    throw new QuotaError("error", "인증을 자동 갱신 중이거나 연결을 확인하지 못했습니다. 잠시 후 다시 조회하세요.", 15000);
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    for (const release of releases.reverse()) await release().catch(() => {});
  }
}
async function claudeAccount(home: string, fetchApi: typeof fetch, signal?: AbortSignal) {
  let oauth = (await claudeCredentials(home)).claudeAiOauth;
  if (typeof oauth?.expiresAt === "number" && oauth.expiresAt <= Date.now() + 120000 && oauth.refreshToken)
    oauth = await refreshClaude(home, fetchApi, signal);
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) throw new QuotaError("unavailable", "이 인증 방식은 구독 한도를 제공하지 않습니다.");
  const request = async (path: string, body?: object, retried = false): Promise<any> => {
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, body ? 25000 : 10000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
    let response;
    try { response = await fetchApi("https://api.anthropic.com" + path, {
      method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${oauth.accessToken}`, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-cli/2.1.285 (external, cli)", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }); } catch { throw new QuotaError("error", body ? "Claude 리셋 결과를 확인하지 못했습니다." : "Claude 한도를 조회하지 못했습니다. 연결을 확인하고 새로고침하세요."); }
    const revoked = response.status === 403 && /OAuth token has been revoked/i.test(await response.clone().text());
    if ((response.status === 401 || revoked) && !body && !retried) {
      const previous = oauth.accessToken;
      oauth = await refreshClaude(home, fetchApi, signal, previous);
      if (oauth?.accessToken && oauth.accessToken !== previous) return request(path, body, true);
    }
    if (body && [401, 403, 429].includes(response.status)) return { result: response.status === 429 ? "rate_limited" : "auth_error" };
    if (response.status === 401 || revoked) throw new QuotaError("auth-required", "인증 자동 갱신으로 복구하지 못했습니다. 이 계정에 다시 로그인하세요.", 300000);
    if (response.status === 403) throw new QuotaError("error", "Claude 한도 조회 권한을 확인하지 못했습니다. 서비스의 계정·조직 권한을 확인하세요.", 300000);
    if (response.status === 429) {
      const header = response.headers.get("retry-after"), seconds = header === null ? NaN : Number(header);
      const retry = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header ?? "") - Date.now();
      throw new QuotaError("error", "한도 조회 요청이 많습니다. 잠시 후 다시 시도하세요.", Math.max(60000, Number.isFinite(retry) ? retry : 60000));
    }
    if (!response.ok) throw new QuotaError("error", "Claude 응답을 확인하지 못했습니다. 잠시 후 다시 조회하세요.");
    try { return await response.json(); } catch { throw new QuotaError("error", "Claude 응답을 읽지 못했습니다."); }
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
  const profile = async () => {
    const data = await request("/api/oauth/profile"), user = data?.account?.uuid, organization = data?.organization?.uuid;
    if (typeof user !== "string" || typeof organization !== "string" || !claudeUuid.test(user) || !claudeUuid.test(organization))
      throw new QuotaError("error", "Claude 리셋 계정 신원 응답을 확인하지 못했습니다. 다시 조회하세요.");
    return { organization: organization.toLowerCase(), identity: createHash("sha256").update(JSON.stringify(["claude", user, organization])).digest("hex") };
  };
  return { request, profile, plan: oauth.subscriptionType };
}
export async function claudeResetIdentity(home: string, fetchApi: typeof fetch = fetch): Promise<string> {
  return (await (await claudeAccount(home, fetchApi)).profile()).identity;
}
export async function claudeQuota(home: string, fetchApi: typeof fetch = fetch, signal?: AbortSignal): Promise<Quota> {
  const account = await claudeAccount(home, fetchApi, signal);
  return parseClaudeQuota(await account.request(CLAUDE_USAGE_PATH), account.plan);
}
export async function claudeConsumeReset(home: string, attemptId: string, creditId: string | null, expectedIdentity: string,
  fetchApi: typeof fetch = fetch, retry = false): Promise<ResetOutcome> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(attemptId) || !creditId || !/^[a-z0-9_-]{1,40}$/.test(creditId))
    throw new QuotaError("error", "Claude 리셋권 선택 정보를 확인하세요.");
  const account = await claudeAccount(home, fetchApi), profile = await account.profile();
  if (profile.identity !== expectedIdentity) throw new QuotaError("auth-required", "Claude 로그인 계정이 변경되어 리셋을 중단했습니다.");
  if (!retry) {
    const credits = parseClaudeResetCredits((await account.request(CLAUDE_USAGE_PATH)).cedar_ember);
    if (credits.credits?.find(credit => credit.id === creditId)?.status !== "available") throw new QuotaError("error", "선택한 Claude 리셋권은 현재 사용할 수 없습니다.");
    if ((await account.profile()).identity !== expectedIdentity)
      throw new QuotaError("auth-required", "Claude 로그인 계정이 변경되어 리셋을 중단했습니다.");
  }
  const response = await account.request(`/api/organizations/${profile.organization}/reset_rate_limits`,
    { program: "cedar_ember", grant_id: creditId, request_id: attemptId });
  const outcomes: Record<string, ResetOutcome> = { reset: "reset", already_used: "alreadyRedeemed", not_limited: "nothingToReset",
    cooldown: "cooldown", ineligible: "noCredit", unavailable: "unavailable", rate_limited: "rateLimited", auth_error: "authRequired" };
  if (!Object.hasOwn(outcomes, response?.result)) throw new QuotaError("error", "Claude 리셋 결과를 확인하지 못했습니다.");
  return outcomes[response.result];
}

export class QuotaCache {
  private entries = new Map<string, { value: Quota; nextAt: number; forceAt: number; pending: boolean; operation?: Promise<void>; previous?: { value: Quota; nextAt: number; forceAt: number } }>();
  private controller = new AbortController();
  private file?: string;
  private writes: Promise<unknown> = Promise.resolve();
  // ponytail: serialize native quota processes; use a small worker pool if many accounts make refresh slow.
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private now: () => number = Date.now) {}
  async restore(file: string) {
    this.file = file;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return;
      for (const [key, saved] of Object.entries(JSON.parse(await readFile(file, "utf8"))) as [string, any][]) {
        const value = QuotaSchema.safeParse(saved?.value);
        if (value.success && value.data.status !== "loading" && Number.isFinite(saved.nextAt) && Number.isFinite(saved.forceAt))
          this.entries.set(key, { value: value.data, nextAt: saved.nextAt, forceAt: saved.forceAt, pending: false });
      }
    } catch { /* Missing/invalid optional cache must not damage account or session metadata. */ }
  }
  private persist() {
    if (!this.file || this.controller.signal.aborted) return Promise.resolve();
    const file = this.file;
    const operation = this.writes.then(() => atomicWrite(file, JSON.stringify(Object.fromEntries([...this.entries]
      .filter(([, e]) => e.value.status !== "loading" || e.previous).map(([key, e]) => [key, e.value.status === "loading" ? e.previous : { value: e.value, nextAt: e.nextAt, forceAt: e.forceAt }])))));
    this.writes = operation.catch(() => {});
    return this.writes;
  }
  get(key: string, load: (signal: AbortSignal) => Promise<Quota>, force: boolean | "fresh" = false): Quota {
    const time = this.now();
    let entry = this.entries.get(key);
    if (entry && (entry.pending || time < (force === "fresh" && entry.value.status === "available" ? 0 : force ? entry.forceAt : entry.nextAt))) return entry.value;
    entry ??= { value: unavailableQuota(), nextAt: 0, forceAt: 0, pending: false };
    this.entries.set(key, entry);
    entry.previous = { value: entry.value, nextAt: entry.nextAt, forceAt: entry.forceAt };
    entry.pending = true; entry.forceAt = time + 10000; entry.value = { ...entry.value, status: "loading", error: null };
    const current = entry;
    const operation = this.queue.then(async () => {
      if (this.controller.signal.aborted) { current.pending = false; return; }
      try {
        current.value = { ...QuotaSchema.parse(await load(this.controller.signal)), retryAt: null };
        current.nextAt = this.now() + 5 * 60 * 1000;
      } catch (error) {
        const cause = error instanceof QuotaError ? error : new QuotaError("error", "한도를 조회하지 못했습니다. 잠시 후 새로고침하세요.");
        current.value = { ...current.value, status: cause.status, error: /^[가-힣]/.test(cause.message) ? cause.message : "한도를 조회하지 못했습니다. 잠시 후 다시 조회하세요." };
        current.nextAt = this.now() + cause.retryAfterMs;
        current.forceAt = Math.max(current.forceAt, current.nextAt);
        current.value.retryAt = new Date(current.nextAt).toISOString();
      } finally { current.pending = false; await this.persist(); }
    });
    current.operation = operation;
    this.queue = operation.catch(() => {});
    return current.value;
  }
  async read(key: string, load: (signal: AbortSignal) => Promise<Quota>): Promise<Quota> {
    this.get(key, load, "fresh");
    const entry = this.entries.get(key)!;
    await entry.operation;
    const value = entry.value;
    if (value.status !== "available" || value.error) throw new QuotaError(value.status === "auth-required" || value.status === "unavailable" ? value.status : "error",
      value.error ?? "한도를 확인하지 못했습니다. 잠시 후 다시 조회하세요.", Math.max(0, entry.nextAt - this.now()));
    return value;
  }
  async settled() { await this.queue; await this.writes; }
  clearRow(row: string) { for (const key of this.entries.keys()) if (key.startsWith(row + ":")) this.entries.delete(key); void this.persist(); }
  clearIdentity(identity: string) { for (const key of this.entries.keys()) if (key.endsWith(":" + identity)) this.entries.delete(key); void this.persist(); }
  put(key: string, value: Quota) { this.entries.set(key, { value, nextAt: this.now() + 300000, forceAt: this.now() + 10000, pending: false }); void this.persist(); }
  stop() { this.controller.abort(); this.entries.clear(); }
}

async function files(root: string): Promise<string[]> {
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink()) throw new Error("사용 기록에 안전하지 않은 경로가 있습니다.");
    if (stat.isFile()) return [root];
    if (!stat.isDirectory()) return [];
    const result: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("사용 기록에 안전하지 않은 경로가 있습니다.");
      if (entry.isDirectory() || entry.isFile()) result.push(...await files(join(root, entry.name)));
    }
    return result;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function tokens(usage: any, harness: Harness): TokenTotals | null {
  const input = usage?.input_tokens, output = usage?.output_tokens;
  const read = usage?.[harness === "codex" ? "cached_input_tokens" : "cache_read_input_tokens"] ?? 0;
  const write = usage?.[harness === "codex" ? "cache_write_input_tokens" : "cache_creation_input_tokens"] ?? 0;
  if (![input, output, read, write].every(number)) return null;
  return { inputTokens: input + (harness === "claude" ? read + write : 0), outputTokens: output,
    cachedInputTokens: read, cacheWriteInputTokens: write };
}
export function parseUsage(contents: string[], harness: Harness): UsageCounter {
  const result = emptyCounter(), messages = new Map<string, TokenTotals>();
  let previous = emptyTokens();
  for (const content of contents) for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { result.complete = false; continue; }
    if (harness === "codex") {
      if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;
      const info = record.payload.info;
      if (info == null) continue; // Native context-only notifications contain no usage.
      const total = tokens(info.total_token_usage, harness), last = tokens(info.last_token_usage, harness);
      if (!total) { result.complete = false; continue; }
      const reset = total.inputTokens < previous.inputTokens || total.outputTokens < previous.outputTokens;
      for (const key of Object.keys(total) as (keyof TokenTotals)[]) result.totals[key] += reset
        ? (last?.[key] ?? 0) : Math.max(0, total[key] - previous[key]);
      if (reset && !last) result.complete = false;
      previous = total; result.observed = true;
    } else {
      if (record.type !== "assistant" || !record.message?.usage) continue;
      const usage = tokens(record.message.usage, harness);
      const id = record.message.id;
      if (!usage || typeof id !== "string") { result.complete = false; continue; }
      const key = `${record.requestId ?? ""}:${id}`, prior = messages.get(key) ?? emptyTokens();
      for (const name of Object.keys(usage) as (keyof TokenTotals)[]) prior[name] = Math.max(prior[name], usage[name]);
      messages.set(key, prior); result.observed = true;
    }
  }
  if (harness === "claude") for (const usage of messages.values()) for (const key of Object.keys(usage) as (keyof TokenTotals)[]) result.totals[key] += usage[key];
  return result;
}
export async function readUsage(home: string, harness: Harness, sessionId: string): Promise<UsageCounter> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("네이티브 세션 ID가 올바르지 않습니다.");
  // ponytail: scan only this session's transcripts; add a path index if large native histories become slow.
  const candidates = harness === "codex"
    ? [...await files(join(home, "sessions")), ...await files(join(home, "archived_sessions"))].filter(path => path.endsWith(`-${sessionId}.jsonl`))
    : (await files(join(home, "projects"))).filter(path => path.endsWith(`/${sessionId}.jsonl`) ||
      path.includes(`/${sessionId}/`) && path.endsWith(".jsonl"));
  if (!candidates.length) return { ...emptyCounter(), complete: false };
  const contents = await Promise.all(candidates.map(path => readFile(path, "utf8")));
  // A rollout can be present in both sessions and archived_sessions; use its longest copy.
  return parseUsage(harness === "codex" ? [contents.sort((a, b) => b.length - a.length)[0]] : contents, harness);
}
