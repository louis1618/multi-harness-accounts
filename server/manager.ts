import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { PluginHandlerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { ActionSchema, HarnessSchema, emptyTokens, type Account, type Action, type Harness, type Snapshot, type State, type Metrics, type UsageCounter, type AccountSession, type Quota, type ResetOutcome, ResetOutcomeSchema, SessionSchema } from "../shared/accounts.js";
import { createAdapters, type HarnessAdapter } from "./adapters.js";
import { Store, privateDirectory, AccountError } from "./store.js";
import { QuotaCache, QuotaError, unavailableQuota, emptyCounter } from "./usage.js";
import { nativeSessions } from "./sessions.js";

type PaseoApi = PluginHandlerContext["paseo"];
const execute = promisify(execFile);
const owns = (object: object, key: string) => Object.hasOwn(object, key);
export function selectedAccount(state: State, harness: Harness, agentId: string): string | null {
  return owns(state.overrides, agentId) ? state.overrides[agentId] : state.defaults[harness];
}
type AgentSummary = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];
async function agentsOn(paseo: PaseoApi, archived = false): Promise<AgentSummary[]> {
  const result: AgentSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { includeArchived: archived }, page: { limit: 100, cursor } });
    result.push(...page.entries.map(entry => entry.agent));
    const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
    if (next === cursor) throw new AccountError("에이전트 목록을 가져오지 못했습니다. 새로고침하세요.");
    cursor = next ?? undefined;
  } while (cursor);
  return result;
}

export class AccountManager {
  readonly store: Store;
  readonly adapters: Record<Harness, HarnessAdapter>;
  private jobs = new Map<string, { child: ChildProcess; timer: ReturnType<typeof setTimeout> }>();
  private loginErrors = new Map<string, string>();
  private loginSlots = new Map<Harness, string>();
  private restarting = new Set<string>();
  private disposed = false;
  private ready?: Promise<void>;
  private quotas = new QuotaCache();
  private turnQueues = new Map<string, Promise<unknown>>();
  private resetting = new Set<string>();
  private nativeIndex: { fetchedAt: number; accounts: string; sessions: AccountSession[]; warnings: string[] } | null = null;
  private importing = new Set<string>();
  private restart: (id: string) => Promise<void>;
  constructor(options: { root?: string; adapters?: Record<Harness, HarnessAdapter>; restart?: (id: string) => Promise<void> } = {}) {
    const daemonHome = resolve(process.env.PASEO_HOME ?? join(homedir(), ".paseo"));
    this.store = new Store(options.root ?? join(daemonHome, "harness-accounts"));
    this.adapters = options.adapters ?? createAdapters({}, undefined, fetch, join(this.store.root, "browser"));
    this.restart = options.restart ?? (async id => {
      try {
        await execute("paseo", ["--home", daemonHome, "agent", "reload", id, "--json"], {
          timeout: 25000, maxBuffer: 65536,
        });
      } catch {
        throw new AccountError("에이전트를 다시 시작하지 못했습니다. 호스트의 Paseo 설치를 확인하고 전환을 다시 시도하세요.");
      }
    });
  }
  profile(account: Account) { return join(this.store.root, account.harness, account.id); }
  private initialize() { return this.ready ??= this.store.update(() => {}); }
  private row(harness: Harness, id: string | null) { return id ?? `system:${harness}`; }
  private account(state: State, id: string) {
    const account = state.accounts.find(item => item.id === id);
    if (!account) throw new AccountError("계정을 찾지 못했습니다. 계정 화면을 새로고침하세요.");
    return account;
  }
  async snapshot(paseo: PaseoApi, forceUsage = false): Promise<Snapshot> {
    await this.initialize();
    const [state, agents] = await Promise.all([this.store.read(), agentsOn(paseo)]);
    const identities = new Map<string, string>();
    const statisticsRows = new Map<string, string>();
    const metrics = (harness: Harness, id: string | null, signedIn: boolean, identity: string | null): Metrics => {
      const row = this.row(harness, id);
      if (signedIn && identity) identities.set(row, identity);
      const principal = signedIn ? identity : state.usage.identities[row] ?? null;
      const usage = principal ? state.usage.totals[principal] : null;
      const totals = usage ?? { ...emptyTokens(), turns: 0, incompleteTurns: 0, lastUsedAt: null };
      const sharedStatisticsWith = principal ? statisticsRows.get(principal) ?? null : null;
      if (principal && !sharedStatisticsWith) statisticsRows.set(principal, row);
      const home = id ? this.profile(this.account(state, id)) : this.adapters[harness].systemHome;
      return {
        quota: signedIn ? this.quotas.get(`${row}:${identity ?? "unknown"}`,
          signal => this.adapters[harness].quota(home, id === null, signal), forceUsage) : unavailableQuota("로그인하면 한도를 확인할 수 있습니다."),
        statistics: { ...totals, totalTokens: totals.inputTokens + totals.outputTokens, available: principal !== null, startedAt: state.usage.startedAt },
        isMostRecent: state.usage.mostRecentRow === row && state.usage.mostRecentIdentity === principal,
        sharedStatisticsWith,
      };
    };
    const systemAccounts = await Promise.all((["codex", "claude"] as const).map(async harness => {
      try {
        const row = this.row(harness, null);
        if (this.jobs.has(row)) return { harness, status: "authenticating" as const, email: null, error: null, metrics: metrics(harness, null, false, null) };
        const auth = await this.adapters[harness].status(this.adapters[harness].systemHome, true);
        return { harness, status: auth.signedIn ? "signed-in" as const : "signed-out" as const, email: auth.email, error: this.loginErrors.get(row) ?? null,
          metrics: metrics(harness, null, auth.signedIn, auth.identity) };
      } catch (error) { return { harness, status: "error" as const, email: null, error: this.publicError(error),
        metrics: metrics(harness, null, false, null) }; }
    }));
    const accounts = await Promise.all(state.accounts.map(async account => {
      let status: Snapshot["accounts"][number]["status"] = this.jobs.has(account.id) ? "authenticating" : "signed-out";
      let email: string | null = null;
      let identity: string | null = null;
      let error = this.loginErrors.get(account.id) ?? null;
      if (status !== "authenticating") {
        try {
          const auth = await this.adapters[account.harness].status(this.profile(account));
          if (auth.signedIn) { status = "signed-in"; email = auth.email; identity = auth.identity; }
          else if (error) status = "error";
        } catch (cause) { status = "error"; error = this.publicError(cause); }
      }
      return { ...account, status, email, error, metrics: metrics(account.harness, account.id, status === "signed-in", identity) };
    }));
    if ([...identities].some(([row, identity]) => state.usage.identities[row] !== identity)) {
      await this.store.update(next => { for (const [row, identity] of identities) next.usage.identities[row] = identity; });
    }
    // Establish pre-turn baselines for sessions that were already open when the plugin was updated.
    for (const agent of agents) {
      const harness = HarnessSchema.safeParse(agent.provider);
      if (!harness.success || state.usage.prepared[agent.id] || state.usage.active[agent.id] ||
        !["idle", "error", "closed"].includes(agent.status)) continue;
      const current = await paseo.agents.ref(agent.id).refresh().catch(() => null);
      const sessionId = current?.agent.persistence?.sessionId;
      if (!sessionId || current?.agent.activeTurn) continue;
      const binding = state.bindings[agent.id], adapter = this.adapters[harness.data];
      const home = binding?.home ?? adapter.systemHome;
      let baseline;
      try { baseline = await adapter.usage(home, sessionId); } catch { continue; }
      const confirmed = await paseo.agents.ref(agent.id).refresh().catch(() => null);
      if (!confirmed || confirmed.agent.activeTurn || !["idle", "error", "closed"].includes(confirmed.agent.status)) continue;
      await this.store.update(next => {
        if (next.usage.active[agent.id] || next.usage.prepared[agent.id]) return;
        next.usage.prepared[agent.id] = { sessionId, baseline };
        next.usage.checkpoints[`${harness.data}:${sessionId}`] = baseline;
        if (!next.bindings[agent.id]) next.bindings[agent.id] = {
          harness: harness.data, accountId: null, home, sessionId,
          identity: identities.get(this.row(harness.data, null)) ?? null, generation: randomUUID(),
        };
      });
    }
    const summary = { ...emptyTokens(), totalTokens: 0, turns: 0, incompleteTurns: 0, available: statisticsRows.size > 0,
      startedAt: state.usage.startedAt, lastUsedAt: null as string | null,
      accountCount: accounts.length + systemAccounts.filter(row => row.status === "signed-in").length };
    for (const principal of statisticsRows.keys()) {
      const total = state.usage.totals[principal];
      if (!total) continue;
      for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "turns", "incompleteTurns"] as const) summary[key] += total[key];
      if (total.lastUsedAt && (!summary.lastUsedAt || total.lastUsedAt > summary.lastUsedAt)) summary.lastUsedAt = total.lastUsedAt;
    }
    summary.totalTokens = summary.inputTokens + summary.outputTokens;
    return {
      summary,
      accounts, systemAccounts, defaults: state.defaults,
      agents: agents.flatMap(agent => {
        const parsed = HarnessSchema.safeParse(agent.provider);
        if (!parsed.success || agent.archivedAt) return [];
        const harness = parsed.data;
        return [{
          id: agent.id, title: agent.title ?? agent.id, harness, status: agent.status,
          override: owns(state.overrides, agent.id) ? state.overrides[agent.id] ?? "system" : "inherit" as const,
          desiredAccountId: selectedAccount(state, harness, agent.id),
          currentAccountId: state.bindings[agent.id]?.accountId ?? null,
          pending: owns(state.pending, agent.id), error: state.pending[agent.id]?.error ?? null,
        }];
      }),
    };
  }
  publicError(error: unknown): string {
    // All errors from our adapters and service are fixed messages. Never expose child stderr or OS error objects.
    return error instanceof AccountError ? error.message : "계정 작업에 실패했습니다. 호스트 상태를 확인하고 다시 시도하세요.";
  }
  async sessions(paseo: PaseoApi, refresh = false) {
    await this.initialize();
    const [state, agents] = await Promise.all([this.store.read(), agentsOn(paseo)]);
    const accountKey = state.accounts.map(row => row.id).join(",");
    if (refresh || !this.nativeIndex || this.nativeIndex.accounts !== accountKey || Date.now() - this.nativeIndex.fetchedAt > 30000) {
      const profiles = [
        ...(["codex", "claude"] as const).map(harness => ({ harness, accountId: null as string | null, home: this.adapters[harness].systemHome })),
        ...state.accounts.map(account => ({ harness: account.harness, accountId: account.id, home: this.profile(account) })),
      ];
      const sessions: AccountSession[] = [], warnings: string[] = [];
      for (const profile of profiles) {
        try { sessions.push(...await nativeSessions(profile.home, profile.harness, profile.accountId)); }
        catch { warnings.push(`${profile.harness === "codex" ? "Codex" : "Claude Code"}의 일부 외부 세션을 읽지 못했습니다.`); }
      }
      this.nativeIndex = { fetchedAt: Date.now(), accounts: accountKey, sessions, warnings: [...new Set(warnings)] };
    }
    const sessions: AccountSession[] = [], imported = new Set<string>();
    for (const agent of agents) {
      const harness = HarnessSchema.safeParse(agent.provider);
      if (!harness.success || agent.archivedAt) continue;
      const nativeSessionId = agent.persistence?.sessionId ?? state.bindings[agent.id]?.sessionId ?? null;
      if (nativeSessionId) imported.add(`${harness.data}:${nativeSessionId}`);
      sessions.push({ id: agent.id, agentId: agent.id, harness: harness.data, source: "paseo", nativeSessionId,
        accountId: state.bindings[agent.id]?.accountId ?? null, title: (agent.title ?? "제목 없는 세션").slice(0, 240),
        cwd: agent.cwd ?? "", updatedAt: agent.updatedAt ?? null });
    }
    const native = new Map<string, AccountSession>();
    for (const session of this.nativeIndex.sessions) {
      const key = `${session.harness}:${session.nativeSessionId}`;
      if (imported.has(key)) continue;
      const previous = native.get(key);
      if (!previous || (session.updatedAt ?? "") > (previous.updatedAt ?? "")) native.set(key, session);
    }
    sessions.push(...native.values());
    sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { sessions: sessions.map(row => SessionSchema.parse(row)), warnings: this.nativeIndex.warnings };
  }
  async importSession(id: string, paseo: PaseoApi) {
    const { sessions } = await this.sessions(paseo);
    const selected = sessions.find(row => row.id === id);
    if (!selected) throw new AccountError("선택한 세션을 찾지 못했습니다. 목록을 새로고침하세요.");
    if (selected.agentId) return { agentId: selected.agentId, message: "기존 Paseo 세션을 선택했습니다." };
    if (!selected.nativeSessionId || this.importing.has(id)) throw new AccountError("세션을 불러오고 있습니다. 잠시 기다려 주세요.");
    this.importing.add(id);
    try {
      const state = await this.store.read(), adapter = this.adapters[selected.harness];
      const source = selected.accountId ? this.profile(this.account(state, selected.accountId)) : adapter.systemHome;
      const accountId = state.defaults[selected.harness], account = accountId ? this.account(state, accountId) : null;
      const target = account ? this.profile(account) : adapter.systemHome;
      const directory = await stat(selected.cwd).catch(() => null);
      if (!directory?.isDirectory()) throw new AccountError("세션의 작업 폴더를 찾지 못했습니다. 원래 폴더를 복원한 뒤 불러오세요.");
      await adapter.transferHistory(source, target, selected.nativeSessionId);
      const daemonHome = resolve(process.env.PASEO_HOME ?? join(homedir(), ".paseo"));
      let result;
      try {
        const { stdout } = await execute("paseo", ["--home", daemonHome, "import",
          "--provider", selected.harness, "--cwd", selected.cwd, "--json", "--", selected.nativeSessionId], { timeout: 55000, maxBuffer: 65536 });
        result = JSON.parse(stdout);
      } catch { throw new AccountError("외부 세션을 불러오지 못했습니다. 로그인 상태와 작업 폴더를 확인하세요. 원본 대화 기록은 유지됩니다."); }
      if (typeof result.agentId !== "string") throw new AccountError("세션을 불러왔지만 에이전트 정보를 확인하지 못했습니다. 목록을 새로고침하세요.");
      await this.prepareCreatedAgent(result.agentId, paseo);
      this.nativeIndex = null;
      return { agentId: result.agentId, message: "기존 대화를 Paseo로 불러왔습니다. 사용할 계정을 지정하세요." };
    } finally { this.importing.delete(id); }
  }
  async prepareCreatedAgent(id: string, paseo: PaseoApi) {
    await this.initialize();
    const snapshot = await paseo.agents.ref(id).refresh();
    const sessionId = snapshot?.agent.persistence?.sessionId, harness = HarnessSchema.safeParse(snapshot?.agent.provider);
    if (sessionId && harness.success && !snapshot?.agent.activeTurn) {
      const state = await this.store.read(), binding = state.bindings[id];
      if (binding && state.usage.prepared[id]?.sessionId !== sessionId) {
        let baseline;
        try { baseline = await this.adapters[harness.data].usage(binding.home, sessionId); } catch { baseline = null; }
        if (baseline && (baseline.complete || state.usage.prepared[id]?.baseline.complete === false)) await this.store.update(next => {
          if (next.usage.active[id]) return;
          next.usage.prepared[id] = { sessionId, baseline };
          next.usage.checkpoints[`${harness.data}:${sessionId}`] = baseline;
          if (next.bindings[id]) next.bindings[id].sessionId = sessionId;
        });
      }
    }
    await this.applyPending(id, paseo);
  }
  private blockUncertainCredits(quota: Quota, state: State, identity: string): Quota {
    const unresolved = Object.values(state.resetAttempts).filter(attempt => attempt.harness === "claude" &&
      attempt.identity === identity && attempt.stage === "pending" && attempt.submittedAt && Date.now() - Date.parse(attempt.submittedAt) >= 600000);
    if (!quota.resetCredits || !unresolved.length) return quota;
    return { ...quota, resetCredits: { ...quota.resetCredits, credits: quota.resetCredits.credits?.map(credit =>
      unresolved.some(attempt => attempt.creditId === credit.id) ? { ...credit, status: "blocked",
        blockedReason: "이 리셋권의 이전 사용 결과를 확인하지 못했습니다. Claude 사용량 화면에서 확인하세요." } : credit) ?? null } };
  }
  async prepareReset(accountId: string | null, harness: Harness = "codex") {
    await this.initialize();
    const state = await this.store.read(), account = accountId ? this.account(state, accountId) : null;
    if (account && account.harness !== harness) throw new AccountError("선택한 계정의 서비스가 다릅니다.");
    if (this.jobs.has(this.row(harness, accountId)) || accountId && this.jobs.has(accountId)) throw new AccountError("로그인을 완료한 뒤 리셋권을 조회하세요.");
    const adapter = this.adapters[harness], home = account ? this.profile(account) : adapter.systemHome;
    const auth = await adapter.status(home, account === null);
    const identity = auth.signedIn ? await adapter.resetIdentity(home, account === null) : null;
    if (!identity) throw new AccountError("로그인한 계정을 확인하지 못했습니다. 다시 로그인한 뒤 조회하세요.");
    if (this.resetting.has(identity)) throw new AccountError("리셋 요청 처리 중입니다. 완료 후 다시 조회하세요.");
    let quota;
    try { quota = await adapter.quota(home, account === null); }
    catch (error) { throw new AccountError(error instanceof QuotaError ? error.message : "리셋권을 조회하지 못했습니다. 잠시 후 다시 시도하세요."); }
    quota = this.blockUncertainCredits(quota, state, identity);
    this.quotas.put(`${this.row(harness, accountId)}:${identity}`, quota);
    const attempt = await this.store.update(next => {
      let value: State["resetAttempts"][string] | undefined = next.resetAttempts[identity];
      if (value?.harness === "claude" && value.stage === "pending" && value.submittedAt && Date.now() - Date.parse(value.submittedAt) >= 600000) {
        next.resetAttempts[`${identity}:${value.id}`] = value;
        value = undefined;
      }
      if (!value || value.stage === "complete" || value.stage === "prepared" && Date.now() - Date.parse(value.createdAt) > 30 * 60000) {
        value = { id: randomUUID(), accountId, harness, identity, submittedAt: null, createdAt: new Date().toISOString(), stage: "prepared", creditId: null, outcome: null };
        next.resetAttempts[identity] = value;
      } else if (value.stage === "prepared") value.accountId = accountId;
      return value;
    });
    return { attemptId: attempt.id, quota, pending: attempt.stage === "pending", creditId: attempt.creditId };
  }
  async consumeReset(attemptId: string, creditId: string | null, confirmed: true) {
    if (confirmed !== true) throw new AccountError("리셋권 사용을 확인한 뒤 실행하세요.");
    await this.initialize();
    const state = await this.store.read();
    const attempt = Object.values(state.resetAttempts).find(value => value.id === attemptId);
    if (!attempt) throw new AccountError("리셋권 목록을 다시 열어 확인하세요.");
    if (attempt.stage === "complete") return { outcome: ResetOutcomeSchema.parse(attempt.outcome === "reset" || attempt.outcome === "alreadyRedeemed" ? "alreadyRedeemed" : attempt.outcome),
      message: "이미 처리한 리셋 요청입니다. 한도를 새로 확인하세요." };
    if (this.resetting.has(attempt.identity)) throw new AccountError("리셋 요청을 처리하고 있습니다. 완료될 때까지 기다려 주세요.");
    this.resetting.add(attempt.identity);
    try {
      const account = attempt.accountId ? this.account(state, attempt.accountId) : null;
      const harness = attempt.harness, adapter = this.adapters[harness], home = account ? this.profile(account) : adapter.systemHome;
      if (account && account.harness !== harness || this.jobs.has(this.row(harness, attempt.accountId)) || attempt.accountId && this.jobs.has(attempt.accountId)) throw new AccountError("로그인을 완료한 뒤 다시 확인하세요.");
      if (await adapter.resetIdentity(home, account === null) !== attempt.identity) throw new AccountError("로그인 계정이 변경되었습니다. 원래 계정으로 로그인한 뒤 리셋 결과를 확인하세요.");
      if (attempt.stage === "pending") {
        if (harness === "claude" && (!attempt.submittedAt || Date.now() - Date.parse(attempt.submittedAt) >= 600000))
          throw new AccountError("Claude 리셋 결과 확인 기간 10분이 지났습니다. 재전송하지 않습니다. Claude 사용량 화면에서 확인하세요.");
        if (attempt.creditId !== creditId) throw new AccountError("결과가 확인되지 않은 요청은 선택한 리셋권을 변경할 수 없습니다.");
      } else {
        const quota = this.blockUncertainCredits(await adapter.quota(home, account === null).catch(() => { throw new AccountError("최신 리셋권 정보를 확인하지 못했습니다. 다시 조회하세요."); }), state, attempt.identity);
        const credits = quota.resetCredits;
        if (!credits || credits.availableCount === 0) throw new AccountError("사용 가능한 리셋권이 없습니다.");
        if (harness === "claude" && !creditId) throw new AccountError("사용할 Claude 리셋권을 선택하세요.");
        if (creditId) {
          const credit = credits.credits?.find(row => row.id === creditId);
          if (!credit || credit.status !== "available" || credit.resetType !== (harness === "claude" ? "claudeRateLimits" : "codexRateLimits") || credit.expiresAt && Date.parse(credit.expiresAt) <= Date.now())
            throw new AccountError("선택한 리셋권은 사용할 수 없습니다. 목록을 다시 조회하세요.");
        }
        await this.store.update(next => {
          const stored = next.resetAttempts[attempt.identity];
          if (stored?.id !== attemptId) throw new AccountError("리셋권 목록을 다시 열어 확인하세요.");
          stored.stage = "pending"; stored.creditId = creditId; stored.submittedAt = new Date().toISOString();
        });
      }
      let outcome;
      try { outcome = await adapter.consumeReset(home, attemptId, creditId, account === null, attempt.identity, attempt.stage === "pending"); }
      catch { throw new AccountError("리셋 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요. 새 리셋권은 사용하지 않습니다."); }
      await this.store.update(next => {
        const stored = next.resetAttempts[attempt.identity];
        if (stored?.id === attemptId) { stored.stage = "complete"; stored.outcome = outcome; }
      });
      this.quotas.clearIdentity(attempt.identity);
      const messages: Record<ResetOutcome, string> = { reset: "리셋권 1개를 사용했습니다. 한도를 새로 확인하고 있습니다.",
        alreadyRedeemed: "이 요청의 리셋은 이미 완료되었습니다. 추가 리셋권은 사용하지 않았습니다.",
        nothingToReset: "현재 초기화할 수 있는 한도가 없습니다. 리셋권은 사용하지 않았습니다.",
        noCredit: "현재 사용할 수 있는 리셋권이 없습니다.",
        cooldown: "리셋 재사용 대기 중입니다. 리셋권은 사용하지 않았습니다.",
        rateLimited: "리셋 요청이 많습니다. 잠시 후 다시 조회하세요. 리셋권은 사용하지 않았습니다.",
        authRequired: "리셋 인증이 만료되었습니다. 다시 로그인한 뒤 조회하세요. 리셋권은 사용하지 않았습니다.",
        unavailable: "현재 서비스에서 리셋을 제공하지 않습니다. 리셋권은 사용하지 않았습니다." };
      return { outcome, message: messages[outcome] };
    } finally { this.resetting.delete(attempt.identity); }
  }
  async change(input: Action, paseo: PaseoApi): Promise<{ message: string }> {
    await this.initialize();
    const action = ActionSchema.parse(input);
    if (action.action === "cancel-system-login") {
      this.cancelLogin(this.row(action.harness, null));
      return { message: "시스템 계정 로그인을 취소했습니다." };
    }
    if (action.action === "relogin-system" || action.action === "logout-system") {
      const state = await this.store.read(), adapter = this.adapters[action.harness], row = this.row(action.harness, null);
      const agents = await agentsOn(paseo, true);
      const affected = agents.filter(agent => agent.provider === action.harness &&
        (state.bindings[agent.id] ? state.bindings[agent.id].accountId === null : selectedAccount(state, action.harness, agent.id) === null));
      if (affected.some(agent => !agent.archivedAt && ["running", "initializing"].includes(agent.status)))
        throw new AccountError("시스템 계정의 실행 중인 작업을 마친 뒤 로그인 상태를 변경하세요.");
      if (action.action === "logout-system" && affected.some(agent => !agent.archivedAt && agent.status !== "closed"))
        throw new AccountError("시스템 계정의 에이전트를 닫거나 다른 계정으로 전환한 뒤 로그아웃하세요.");
      const occupied = this.loginSlots.get(action.harness);
      if (occupied && occupied !== row) throw new AccountError("진행 중인 브라우저 로그인을 완료하거나 취소하세요.");
      this.cancelLogin(row);
      if (action.action === "relogin-system") this.loginSlots.set(action.harness, row);
      try {
        if ((await adapter.status(adapter.systemHome, true)).signedIn) await adapter.logout(adapter.systemHome, true);
        this.quotas.clearRow(row);
        if (action.action === "relogin-system") {
          await this.startLogin({ id: row, harness: action.harness, label: "시스템 계정", createdAt: new Date().toISOString() }, paseo, true);
          return { message: "기본 브라우저에서 시스템 계정 인증을 완료하세요. 이 호스트의 기본 CLI 로그인이 변경됩니다." };
        }
      } catch (error) { this.loginSlots.delete(action.harness); throw error; }
      this.loginErrors.delete(row);
      return { message: "시스템 계정을 로그아웃했습니다. 설정과 대화 기록은 보존했습니다." };
    }
    if (action.action === "refresh-usage") {
      await this.snapshot(paseo, true);
      return { message: "계정별 한도를 새로 조회하고 있습니다." };
    }
    if (action.action === "add") {
      const account: Account = { id: randomUUID(), harness: action.harness, label: action.label, createdAt: new Date().toISOString() };
      this.claimLogin(account);
      try {
        await this.store.read();
        await privateDirectory(join(this.store.root, account.harness));
        await this.adapters[account.harness].prepare(this.profile(account));
        await this.store.update(state => { state.accounts.push(account); });
        await this.startLogin(account, paseo);
      } catch (error) { this.loginSlots.delete(account.harness); throw error; }
      return { message: "로그인을 시작했습니다. 호스트의 기본 브라우저에서 인증을 완료하세요." };
    }
    if (action.action === "cancel-login") {
      const state = await this.store.read();
      this.account(state, action.id);
      this.cancelLogin(action.id);
      return { message: "로그인을 취소했습니다. 다시 로그인으로 재시도하세요." };
    }
    if (action.action === "relogin" || action.action === "remove") {
      const state = await this.store.read();
      const account = this.account(state, action.id);
      const agents = await agentsOn(paseo, true);
      const bound = agents.filter(agent => state.bindings[agent.id]?.accountId === account.id);
      if (action.action === "relogin") {
        if (bound.some(agent => ["running", "initializing"].includes(agent.status))) {
          throw new AccountError("이 계정의 실행 중인 작업을 마친 뒤 다시 로그인하세요.");
        }
        this.cancelLogin(account.id);
        this.claimLogin(account);
        try {
          await this.adapters[account.harness].logout(this.profile(account));
          await this.startLogin(account, paseo);
        } catch (error) { this.loginSlots.delete(account.harness); throw error; }
        return { message: "로그인을 다시 시작했습니다. 호스트의 기본 브라우저에서 인증을 완료하세요." };
      }
      if (bound.some(agent => !agent.archivedAt && agent.status !== "closed")) {
        throw new AccountError("이 계정을 사용하는 에이전트가 열려 있습니다. 다른 계정으로 전환한 뒤 삭제하세요.");
      }
      this.cancelLogin(account.id);
      // Preserve closed and archived conversations without retaining the removed account's credentials.
      const backups: Record<string, string> = {};
      for (const agent of bound) {
        const snapshot = await paseo.agents.ref(agent.id).refresh();
        const sessionId = snapshot?.agent.persistence?.sessionId ?? state.bindings[agent.id]?.sessionId;
        if (!sessionId) continue;
        const backup = join(this.store.root, "history", agent.id);
        await this.adapters[account.harness].transferHistory(this.profile(account), backup, sessionId);
        backups[agent.id] = backup;
      }
      await this.adapters[account.harness].logout(this.profile(account));
      await this.store.update(next => {
        next.accounts = next.accounts.filter(item => item.id !== account.id);
        if (next.defaults[account.harness] === account.id) next.defaults[account.harness] = null;
        for (const [id, value] of Object.entries(next.overrides)) if (value === account.id) delete next.overrides[id];
        for (const [id, binding] of Object.entries(next.bindings)) {
          if (binding.accountId === account.id) {
            binding.accountId = null;
            binding.home = backups[id] ?? this.adapters[binding.harness].systemHome;
          }
        }
      });
      this.loginErrors.delete(account.id);
      // Commit the history location before deleting its previous home, so a crash cannot orphan it.
      try { await rm(this.profile(account), { recursive: true, force: true }); }
      catch { return { message: "계정과 인증 정보를 삭제했습니다. 프로필 디렉터리 정리는 완료하지 못했습니다." }; }
      return { message: "계정을 삭제했습니다. 닫힌 대화의 기록은 보존했습니다." };
    }
    const agents = await agentsOn(paseo);
    if (action.action === "retry") {
      if (!agents.some(agent => agent.id === action.agentId)) throw new AccountError("에이전트를 찾지 못했습니다.");
      await this.store.update(state => { state.pending[action.agentId] = { error: null }; });
      await this.applyPending(action.agentId, paseo);
      return { message: "전환을 요청했습니다. 실행 중인 작업이 끝나면 계정이 변경됩니다." };
    }
    const targetAgent = action.agentId ? agents.find(agent => agent.id === action.agentId) : undefined;
    if (action.agentId && (!targetAgent || !HarnessSchema.safeParse(targetAgent.provider).success)) throw new AccountError("지원하는 에이전트를 찾지 못했습니다.");
    if (action.action === "select" && targetAgent && targetAgent.provider !== action.harness) throw new AccountError("이 계정은 다른 코딩 에이전트용 계정입니다.");
    if (action.action === "select" && action.accountId) {
      const state = await this.store.read();
      const account = this.account(state, action.accountId);
      if (account.harness !== action.harness) throw new AccountError("이 계정은 다른 코딩 에이전트용 계정입니다.");
      if (this.jobs.has(account.id) || !(await this.adapters[account.harness].status(this.profile(account))).signedIn) {
        throw new AccountError("계정의 로그인을 완료한 뒤 전환하세요.");
      }
      this.adapters[account.harness].environment(this.profile(account));
    }
    const affected: string[] = [];
    await this.store.update(state => {
      if (action.action === "inherit") delete state.overrides[action.agentId];
      else if (action.agentId) state.overrides[action.agentId] = action.accountId;
      else state.defaults[action.harness] = action.accountId;
      for (const agent of agents) {
        const applies = action.agentId ? agent.id === action.agentId :
          action.action === "select" && agent.provider === action.harness && !owns(state.overrides, agent.id);
        if (applies && !agent.archivedAt) {
          state.pending[agent.id] = { error: null };
          affected.push(agent.id);
        }
      }
    });
    // Release the storage queue before restart: the resulting lifecycle hook writes the same store.
    await Promise.all(affected.map(id => this.applyPending(id, paseo)));
    const state = await this.store.read();
    const failed = affected.filter(id => state.pending[id]?.error).length;
    return { message: failed ? `계정을 선택했지만 에이전트 ${failed}개를 다시 시작하지 못했습니다. 해당 에이전트에서 전환을 다시 시도하세요.` :
      "계정을 선택했습니다. 대기 중인 에이전트는 바로 전환하고, 실행 중이거나 닫힌 에이전트는 작업 종료 또는 다음 열기 시 전환합니다." };
  }
  private claimLogin(account: Account) {
    const occupied = this.loginSlots.get(account.harness);
    if (occupied && occupied !== account.id) throw new AccountError("진행 중인 브라우저 로그인을 완료하거나 취소한 뒤 새 로그인을 시작하세요.");
    this.loginSlots.set(account.harness, account.id);
  }
  private async startLogin(account: Account, paseo: PaseoApi, native = false) {
    if (this.jobs.has(account.id)) throw new AccountError("이 계정은 이미 로그인 중입니다.");
    this.claimLogin(account);
    this.loginErrors.delete(account.id);
    let child: ChildProcess;
    try { child = await this.adapters[account.harness].login(native ? this.adapters[account.harness].systemHome : this.profile(account), native); }
    catch (error) { this.loginErrors.set(account.id, this.publicError(error)); throw error; }
    const timer = setTimeout(() => {
      this.cancelLogin(account.id);
      this.loginErrors.set(account.id, "10분 동안 로그인이 완료되지 않았습니다. 다시 로그인하세요.");
    }, 10 * 60 * 1000);
    timer.unref();
    this.jobs.set(account.id, { child, timer });
    child.once("exit", code => {
      if (this.jobs.get(account.id)?.child !== child) return;
      clearTimeout(timer);
      this.jobs.delete(account.id);
      this.loginSlots.delete(account.harness);
      if (code !== 0) this.loginErrors.set(account.id, "로그인이 완료되지 않았습니다. 다시 로그인하세요.");
      else if (!this.disposed) void this.loginFinished(account, paseo, native).catch(() => {
        this.loginErrors.set(account.id, "로그인은 완료했지만 에이전트를 갱신하지 못했습니다. 전환을 다시 시도하세요.");
      });
    });
  }
  private async loginFinished(account: Account, paseo: PaseoApi, native = false) {
    this.quotas.clearRow(account.id);
    if (!(await this.adapters[account.harness].status(native ? this.adapters[account.harness].systemHome : this.profile(account), native)).signedIn) {
      this.loginErrors.set(account.id, "인증 정보가 저장되지 않았습니다. 다시 로그인하세요.");
      return;
    }
    const agents = await agentsOn(paseo);
    const ids = await this.store.update(state => {
      const ids = agents.filter(agent => agent.provider === account.harness &&
        selectedAccount(state, account.harness, agent.id) === (native ? null : account.id)).map(agent => agent.id);
      for (const id of ids) state.pending[id] = { error: null };
      return ids;
    });
    await Promise.all(ids.map(id => this.applyPending(id, paseo)));
  }
  cancelLogin(id: string) {
    const job = this.jobs.get(id);
    if (job) { this.jobs.delete(id); clearTimeout(job.timer); job.child.kill("SIGTERM"); }
    for (const [harness, accountId] of this.loginSlots) if (accountId === id) this.loginSlots.delete(harness);
  }
  async applyPending(id: string, paseo: PaseoApi) {
    if (this.disposed || this.restarting.has(id) || !owns((await this.store.read()).pending, id)) return;
    this.restarting.add(id);
    try {
      const snapshot = await paseo.agents.ref(id).refresh();
      if (!snapshot || snapshot.agent.archivedAt || !["idle", "error"].includes(snapshot.agent.status) || snapshot.agent.activeTurn) return;
      await this.restart(id);
    } catch (error) {
      await this.store.update(state => { state.pending[id] = { error: this.publicError(error) }; });
    } finally { this.restarting.delete(id); }
  }
  async openSession(request: PluginSessionOpenRequest, paseo: PaseoApi): Promise<PluginSessionOpenRequest> {
    await this.initialize();
    const parsed = HarnessSchema.safeParse(request.provider);
    if (!parsed.success) return request;
    const harness = parsed.data;
    const adapter = this.adapters[harness];
    const state = await this.store.read();
    const binding = state.bindings[request.agentId];
    const id = request.purpose === "history" && binding ? binding.accountId : selectedAccount(state, harness, request.agentId);
    const untouchedSystem = !id && !binding && !owns(state.overrides, request.agentId);
    const account = id ? this.account(state, id) : null;
    if (account && account.harness !== harness) throw new AccountError("에이전트에 지정된 계정의 종류가 다릅니다. 올바른 계정을 선택하세요.");
    const home = request.purpose === "history" && binding ? binding.home : account ? this.profile(account) : adapter.systemHome;
    if (!account && request.purpose === "interactive" && this.jobs.has(this.row(harness, null))) throw new AccountError("시스템 계정 로그인을 완료한 뒤 에이전트를 여세요.");
    if (account && (this.jobs.has(id!) || !(await adapter.status(home)).signedIn)) throw new AccountError("에이전트를 열기 전에 선택한 계정에 다시 로그인하세요.");
    const env = account ? adapter.environment(home, request.env) : untouchedSystem ? { ...request.env } : { ...request.env, [adapter.homeVariable]: home };
    if (!account && harness === "claude" && !process.env.CLAUDE_CONFIG_DIR && !request.env.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
    if (account) await privateDirectory(home);
    if (request.purpose === "interactive") {
      const snapshot = (request.reason === "create" || request.reason === "import") ? null : await paseo.agents.ref(request.agentId).refresh();
      const sessionId = snapshot?.agent.persistence?.sessionId ?? binding?.sessionId ?? null;
      const source = binding?.home ?? request.env[adapter.homeVariable] ?? adapter.systemHome;
      if (sessionId && resolve(source) !== resolve(home)) await adapter.transferHistory(source, home, sessionId);
      const auth = await adapter.status(home, !account);
      let baseline = emptyCounter();
      if (request.reason === "import" && !sessionId) baseline.complete = false;
      if (sessionId) try { baseline = await adapter.usage(home, sessionId); } catch { baseline.complete = false; }
      await this.store.update(next => {
        next.bindings[request.agentId] = { harness, accountId: id, home, sessionId, identity: auth.identity, generation: randomUUID() };
        next.usage.prepared[request.agentId] = { sessionId, baseline };
        if (sessionId) next.usage.checkpoints[`${harness}:${sessionId}`] = baseline;
        delete next.pending[request.agentId];
      });
    }
    return { ...request, env };
  }
  private serialTurn(id: string, operation: () => Promise<void>) {
    const prior = this.turnQueues.get(id) ?? Promise.resolve();
    const next = prior.then(operation);
    const tracked = next.catch(() => {});
    this.turnQueues.set(id, tracked);
    return next.finally(() => { if (this.turnQueues.get(id) === tracked) this.turnQueues.delete(id); });
  }
  beginTurn(id: string, turnId: string | null, paseo: PaseoApi) {
    const startedAt = new Date().toISOString();
    return this.serialTurn(id, async () => {
      await this.initialize();
      const snapshot = await paseo.agents.ref(id).refresh();
      const parsed = HarnessSchema.safeParse(snapshot?.agent.provider);
      if (!parsed.success || !snapshot) return;
      const harness = parsed.data, state = await this.store.read(), binding = state.bindings[id];
      const sessionId = snapshot.agent.persistence?.sessionId ?? binding?.sessionId ?? null;
      const providerTurnId = turnId ?? snapshot.agent.activeTurn?.turnId ?? null;
      // Native providers restart their local turn counter when the process is reloaded.
      const key = `${binding?.generation ?? ""}:${sessionId ?? ""}:${providerTurnId ?? startedAt}`;
      if (state.usage.finished[id] === key || state.usage.active[id]?.key === key) return;
      const accountId = binding?.accountId ?? null;
      const home = binding?.home ?? this.adapters[harness].systemHome;
      const auth = binding?.identity ? { identity: binding.identity } : await this.adapters[harness].status(home, accountId === null);
      const row = this.row(harness, accountId), prepared = state.usage.prepared[id];
      let baseline: UsageCounter | null = prepared && (prepared.sessionId === sessionId || prepared.sessionId === null)
        ? prepared.baseline : sessionId ? state.usage.checkpoints[`${harness}:${sessionId}`] ?? null : null;
      // An already-running session first seen after installation has no safe pre-turn boundary.
      if (!baseline && sessionId) try { baseline = { ...await this.adapters[harness].usage(home, sessionId), complete: false }; } catch { /* Mark incomplete at completion. */ }
      await this.store.update(next => {
        if (next.usage.active[id]) {
          const previous = next.usage.active[id].identity;
          if (previous && next.usage.totals[previous]) next.usage.totals[previous].incompleteTurns++;
        }
        next.usage.active[id] = { key, turnId: providerTurnId, row, identity: auth.identity, harness, home, native: accountId === null, sessionId, startedAt, baseline };
        if (auth.identity) {
          const totals = next.usage.totals[auth.identity] ??= { ...emptyTokens(), turns: 0, incompleteTurns: 0, lastUsedAt: null };
          totals.turns++; totals.lastUsedAt = startedAt; next.usage.identities[row] = auth.identity;
        }
        if (!next.usage.mostRecentAt || next.usage.mostRecentAt <= startedAt) {
          next.usage.mostRecentRow = row; next.usage.mostRecentIdentity = auth.identity; next.usage.mostRecentAt = startedAt;
        }
      });
    });
  }
  endTurn(id: string, turnId: string | null, paseo: PaseoApi) {
    return this.serialTurn(id, async () => {
      await this.initialize();
      const state = await this.store.read(), active = state.usage.active[id];
      if (!active || turnId && active.turnId !== turnId) return;
      let counter: UsageCounter | null = null;
      const snapshot = await paseo.agents.ref(id).refresh().catch(() => null);
      const sessionId = active.sessionId ?? snapshot?.agent.persistence?.sessionId ?? null;
      if (sessionId) {
        // Native terminal notifications can precede the final transcript flush.
        for (let attempt = 0; attempt < 3; attempt++) {
          try { counter = await this.adapters[active.harness].usage(active.home, sessionId); } catch { counter = null; }
          if (counter?.observed && counter.complete) break;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      await this.store.update(next => {
        if (next.usage.active[id]?.key !== active.key) return;
        const baseline = active.baseline;
        if (active.identity) {
          const totals = next.usage.totals[active.identity];
          if (totals) {
            const valid = counter && baseline && counter.complete && baseline.complete && counter.observed &&
              counter.totals.inputTokens >= baseline.totals.inputTokens && counter.totals.outputTokens >= baseline.totals.outputTokens;
            if (counter && baseline && baseline.complete) for (const key of Object.keys(counter.totals) as (keyof typeof counter.totals)[])
              totals[key] += Math.max(0, counter.totals[key] - baseline.totals[key]);
            if (!valid) totals.incompleteTurns++;
          }
        }
        if (counter && sessionId) {
          next.usage.checkpoints[`${active.harness}:${sessionId}`] = counter;
          next.usage.prepared[id] = { sessionId, baseline: counter };
        } else delete next.usage.prepared[id];
        next.usage.finished[id] = active.key; delete next.usage.active[id];
      });
    }).finally(() => this.applyPending(id, paseo));
  }
  dispose() {
    this.disposed = true;
    for (const id of this.jobs.keys()) this.cancelLogin(id);
    this.quotas.stop();
  }
}
