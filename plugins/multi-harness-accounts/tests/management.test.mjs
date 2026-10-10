import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createAdapters } from "../.test-build/server/adapters.js";
import { AccountManager } from "../.test-build/server/manager.js";
import { nativeSessions } from "../.test-build/server/sessions.js";
import { parseCodexQuota, codexConsumeReset, parseClaudeQuota, parseClaudeResetCredits, claudeQuota, claudeResetIdentity, claudeConsumeReset } from "../.test-build/server/usage.js";
import { ActionSchema, SnapshotSchema, formatResetCountdown } from "../.test-build/shared/accounts.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "paseo-management-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapters = createAdapters(), agents = new Map(), calls = [];
  let identity = "test-identity", loggedIn = true;
  const quota = () => parseCodexQuota({ rateLimits: { primary: { usedPercent: 95, windowDurationMins: 300 } },
    rateLimitResetCredits: { availableCount: 2, credits: ["first", "second"].map((id, i) => ({
      id, resetType: "codexRateLimits", status: "available", grantedAt: Math.floor(Date.now() / 1000) - 86400 * (2 - i),
      expiresAt: Math.floor(Date.now() / 1000) + 86400 * (i + 1),
    })) } });
  for (const harness of ["codex", "claude"]) {
    adapters[harness].systemHome = join(root, harness); await mkdir(adapters[harness].systemHome);
    adapters[harness].status = async () => ({ signedIn: harness === "codex" && loggedIn, email: loggedIn ? "fixture@example.test" : null,
      identity: harness === "codex" && loggedIn ? identity : null });
    adapters[harness].quota = async () => quota();
    adapters[harness].logout = async (home, native) => { calls.push({ type: "logout", home, native }); loggedIn = false; };
    adapters[harness].login = async (home, native) => {
      calls.push({ type: "login", home, native }); const child = new EventEmitter();
      child.kill = () => {}; setTimeout(() => { loggedIn = true; child.emit("exit", 0); }, 30); return child;
    };
  }
  const paseo = { agents: {
    async list() { return { entries: [...agents.values()].map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }; },
    ref(id) { return { async refresh() { return agents.has(id) ? { agent: agents.get(id) } : null; } }; },
  }};
  const manager = new AccountManager({ root: join(root, "accounts"), adapters, restart: async () => {} });
  t.after(() => manager.dispose());
  return { root, manager, adapters, paseo, agents, calls, quota, setIdentity: value => { identity = value; } };
}

test("reset credit DTO preserves unavailable/count-only states and strips unrelated secrets", () => {
  assert.equal(parseCodexQuota({}).resetCredits, null);
  assert.deepEqual(parseCodexQuota({ rateLimitResetCredits: { availableCount: 2, credits: null } }).resetCredits, { availableCount: 2, credits: null });
  const quota = parseCodexQuota({ rateLimitResetCredits: { availableCount: 1, access_token: "secret", credits: [{
    id: "one", resetType: "codexRateLimits", status: "available", grantedAt: 1790700000,
    expiresAt: null, title: "Reset", refresh_token: "secret",
  }, { id: "" }] } });
  assert.equal(quota.resetCredits.credits.length, 1);
  assert.equal(quota.resetCredits.credits[0].grantedAt, "2026-09-29T16:40:00.000Z");
  assert.ok(!JSON.stringify(quota).includes("secret"));
});

test("reset selection survives uncertain response and reload; replay cannot spend another credit", async t => {
  const { root, manager, adapters } = await fixture(t);
  const calls = [];
  adapters.codex.consumeReset = async (home, key, id, native) => {
    calls.push({ home, key, id, native });
    if (calls.length === 1) throw Error("network-after-consumption secret");
    return "alreadyRedeemed";
  };
  const prepared = await manager.prepareReset(null);
  await assert.rejects(manager.consumeReset(prepared.attemptId, "first", false), /확인/);
  await assert.rejects(manager.consumeReset(prepared.attemptId, "not-owned", true), /선택한 리셋권/);
  assert.equal(calls.length, 0);
  await assert.rejects(manager.consumeReset(prepared.attemptId, "second", true), /같은 요청/);
  manager.dispose();
  const resumed = new AccountManager({ root: join(root, "accounts"), adapters }); t.after(() => resumed.dispose());
  const retry = await resumed.prepareReset(null);
  assert.equal(retry.attemptId, prepared.attemptId); assert.equal(retry.pending, true); assert.equal(retry.creditId, "second");
  await assert.rejects(resumed.consumeReset(retry.attemptId, "first", true), /변경할 수 없습니다/);
  assert.equal((await resumed.consumeReset(retry.attemptId, "second", true)).outcome, "alreadyRedeemed");
  assert.equal((await resumed.consumeReset(retry.attemptId, "second", true)).outcome, "alreadyRedeemed");
  assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key); assert.ok(calls.every(row => row.id === "second" && row.native === true));
  assert.ok(!(await readFile(join(root, "accounts", "metadata.json"), "utf8")).includes("secret"));
});

test("reset validates current account identity and credits before sending a native mutation", async t => {
  const { manager, adapters, setIdentity } = await fixture(t);
  let spent = 0;
  adapters.codex.consumeReset = async () => { spent++; return "reset"; };
  const prepared = await manager.prepareReset(null); setIdentity("different-login");
  await assert.rejects(manager.consumeReset(prepared.attemptId, "first", true), /로그인 계정이 변경/);
  assert.equal(spent, 0); setIdentity("test-identity");
  adapters.codex.quota = async () => parseCodexQuota({ rateLimitResetCredits: { availableCount: 0, credits: [] } });
  await assert.rejects(manager.consumeReset(prepared.attemptId, null, true), /사용 가능한 리셋권/);
  assert.equal(spent, 0);
});

test("native consume uses the chosen credit and the same idempotency key in the selected home", async t => {
  const { root } = await fixture(t), command = join(root, "codex-rpc"), capture = join(root, "capture.json");
  await writeFile(command, `#!/usr/bin/env node
import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{
 const value=JSON.parse(line);if(value.id===undefined)return;
 let result={};if(value.method==='account/read')result={account:{type:'chatgpt'}};
 if(value.method==='account/rateLimitResetCredit/consume'){
  writeFileSync(process.env.RESET_CAPTURE,JSON.stringify({home:process.env.CODEX_HOME,params:value.params}));
  result={outcome:'reset'};
 }console.log(JSON.stringify({id:value.id,result}));
});
`, { mode: 0o700 });
  const key = randomUUID();
  assert.equal(await codexConsumeReset(command, { ...process.env, RESET_CAPTURE: capture, CODEX_HOME: join(root, "selected") }, key, "chosen", ["-c", 'cli_auth_credentials_store="file"']), "reset");
  assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), { home: join(root, "selected"), params: { idempotencyKey: key, creditId: "chosen" } });
});

test("system relogin/logout require confirmation, respect running agents, and use the native home", async t => {
  const { manager, adapters, paseo, agents, calls } = await fixture(t);
  assert.throws(() => ActionSchema.parse({ action: "logout-system", harness: "codex", confirmed: false }));
  agents.set("active", { id: "active", provider: "codex", title: "작업", status: "running" });
  await assert.rejects(manager.change({ action: "relogin-system", harness: "codex", confirmed: true }, paseo), /실행 중인 작업/);
  assert.equal(calls.length, 0);
  agents.get("active").status = "idle";
  await assert.rejects(manager.change({ action: "logout-system", harness: "codex", confirmed: true }, paseo), /에이전트를 닫거나/);
  agents.get("active").status = "closed";
  await manager.change({ action: "logout-system", harness: "codex", confirmed: true }, paseo);
  assert.deepEqual(calls[0], { type: "logout", home: adapters.codex.systemHome, native: true });
  await manager.change({ action: "relogin-system", harness: "codex", confirmed: true }, paseo);
  assert.equal(calls.length, 2); assert.equal(calls[1].type, "login"); assert.equal(calls[1].native, true);
  assert.equal((await manager.snapshot(paseo)).systemAccounts.find(row => row.harness === "codex").status, "authenticating");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await manager.snapshot(paseo)).systemAccounts.find(row => row.harness === "codex").status, "signed-in");
});

test("dashboard summary deduplicates the same identity across native and managed profiles", async t => {
  const { manager, paseo } = await fixture(t);
  const id = randomUUID();
  await manager.store.update(state => {
    state.accounts.push({ id, harness: "codex", label: "같은 계정", createdAt: new Date().toISOString() });
    state.usage.totals["test-identity"] = { inputTokens: 8, outputTokens: 4, cachedInputTokens: 3, cacheWriteInputTokens: 0,
      turns: 1, incompleteTurns: 0, lastUsedAt: new Date().toISOString() };
  });
  const snapshot = await manager.snapshot(paseo); SnapshotSchema.parse(snapshot);
  assert.equal(snapshot.summary.totalTokens, 12); assert.equal(snapshot.summary.turns, 1);
  assert.equal(snapshot.accounts[0].metrics.sharedStatisticsWith, "system:codex");
  assert.ok(!JSON.stringify(snapshot).includes("test-identity"));
});

test("session picker reads safe native metadata, deduplicates imports and primes old token history", async t => {
  const { root, manager, adapters, paseo, agents } = await fixture(t);
  const nativeId = randomUUID(), directory = join(adapters.codex.systemHome, "sessions");
  await mkdir(directory);
  const path = join(directory, `rollout-test-${nativeId}.jsonl`);
  const tokenLine = (input, output) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: input, output_tokens: output },
  } } }) + "\n";
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: root } }) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "기존 대화를 계속하기" } }) + "\n" + tokenLine(60, 40));
  const native = await nativeSessions(adapters.codex.systemHome, "codex", null);
  assert.equal(native.length, 1); assert.equal(native[0].title, "기존 대화를 계속하기");
  assert.equal((await manager.sessions(paseo)).sessions[0].source, "native");
  agents.set("imported", { id: "imported", provider: "codex", cwd: root, updatedAt: new Date().toISOString(), title: "불러온 대화",
    status: "idle", activeTurn: null, persistence: { sessionId: nativeId } });
  const request = { agentId: "imported", provider: "codex", cwd: root, workspaceId: null, reason: "import", purpose: "interactive", env: {} };
  // The import before-hook runs before Paseo registers the agent; SDK refresh would throw.
  await manager.openSession(request, { agents: { ref() { throw Error("agent not registered"); } } });
  await manager.prepareCreatedAgent("imported", paseo);
  assert.equal((await manager.sessions(paseo)).sessions.length, 1);
  assert.equal((await manager.importSession("imported", paseo)).agentId, "imported");
  agents.get("imported").status = "running"; agents.get("imported").activeTurn = { turnId: "after-import" };
  await manager.beginTurn("imported", "after-import", paseo); await appendFile(path, tokenLine(68, 44));
  agents.get("imported").status = "idle"; agents.get("imported").activeTurn = null;
  await manager.endTurn("imported", "after-import", paseo);
  assert.equal((await manager.snapshot(paseo)).summary.totalTokens, 12);
  await assert.rejects(manager.importSession("native:../../auth.json", paseo), /선택한 세션/);
  await symlink(path, join(directory, "unsafe.jsonl"));
  await assert.rejects(nativeSessions(adapters.codex.systemHome, "codex", null), /심볼릭 링크/);
});

const claudeGrant = (changes = {}) => ({ eligible: true, at_limit: true, grants: [{ id: "launch_grant", label: "Launch",
  resets_total: 1, resets_left: 1, starts_at: null, ends_at: null, clears: ["five_hour", "seven_day"],
  usable_now: true, paused: false, use_requires_limit: true, ...changes }] });

test("Claude reset grants preserve spent/unavailable states, conditions, expiry and sanitized metadata", () => {
  const parsed = parseClaudeResetCredits(claudeGrant());
  assert.equal(parsed.availableCount, 1); assert.equal(parsed.credits[0].status, "available");
  const spent = parseClaudeResetCredits(claudeGrant({ resets_left: 0 }));
  assert.equal(spent.availableCount, 0); assert.match(spent.credits[0].blockedReason, /이미 사용/);
  const limited = { ...claudeGrant(), at_limit: false };
  assert.match(parseClaudeResetCredits(limited).credits[0].blockedReason, /한도에 도달/);
  const noLimitRequired = { ...claudeGrant({ use_requires_limit: false }), at_limit: false };
  assert.equal(parseClaudeResetCredits(noLimitRequired).credits[0].status, "available");
  for (const change of [{ paused: true }, { usable_now: false }, { ends_at: "2020-01-01T00:00:00Z" }, { starts_at: "2099-01-01T00:00:00Z" }])
    assert.equal(parseClaudeResetCredits(claudeGrant(change)).credits[0].status, "blocked");
  assert.match(parseClaudeResetCredits({ ...claudeGrant(), eligible: false, ineligible_reason: "cli_version" }).reason, /버전/);
  assert.throws(() => parseClaudeResetCredits(claudeGrant({ resets_left: 2 })), /응답/);
  assert.throws(() => parseClaudeResetCredits(claudeGrant({ ends_at: "invalid" })), /날짜/);
  const duplicate = claudeGrant();duplicate.grants.push(duplicate.grants[0]);
  assert.throws(() => parseClaudeResetCredits(duplicate), /응답/);
  const partial = parseClaudeQuota({ five_hour: { utilization: 50 }, cedar_ember: { eligible: true, grants: "bad" } });
  assert.equal(partial.windows[0].usedPercent, 50);assert.equal(partial.resetCredits, null);assert.match(partial.resetError, /응답/);
  const missing = parseClaudeQuota({ five_hour: { utilization: 50 } });
  assert.equal(missing.resetCredits, null);assert.match(missing.resetError, /제공하지/);
  assert.ok(!JSON.stringify(parseClaudeResetCredits({ ...claudeGrant({ access_token: "secret" }), event_props: "secret" })).includes("secret"));
});

test("Claude native account flow reads exact profile and validates fresh identity before any fake redemption", async t => {
  const { root } = await fixture(t), home = join(root, "claude-wire");await mkdir(home);
  await writeFile(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "offline-fixture", subscriptionType: "pro" } }));
  const org = randomUUID(), user = randomUUID(), calls = [];let currentUser = user, result = "reset", grant = claudeGrant(), fail = false, httpStatus = 200;
  const fakeFetch = async (url, options) => {
    assert.ok(url.startsWith("https://api.anthropic.com/api/"));
    assert.equal(options.headers.Authorization, "Bearer offline-fixture");assert.equal(options.redirect, "error");
    assert.match(options.headers["User-Agent"], /^claude-cli\/2\.1\.285/);
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith("/profile")) return Response.json({ account: { uuid: currentUser }, organization: { uuid: org } });
    if (url.includes("/usage?")) {assert.equal(options.method, "GET"); assert.ok(url.endsWith("cedar_ember=1&skip_spend=1"));return Response.json({ five_hour: { utilization: 100 }, cedar_ember: grant });}
    assert.equal(url, `https://api.anthropic.com/api/organizations/${org}/reset_rate_limits`);assert.equal(options.method, "POST");
    if(fail)throw Error("uncertain-response secret");
    return Response.json({ result, event_props: "secret" }, { status: httpStatus });
  };
  const identity = await claudeResetIdentity(home, fakeFetch);
  assert.equal((await claudeQuota(home, fakeFetch)).resetCredits.availableCount, 1);
  const id = randomUUID();assert.equal(await claudeConsumeReset(home, id, "launch_grant", identity, fakeFetch), "reset");
  assert.deepEqual(JSON.parse(calls.find(call => call.method === "POST").body), { program: "cedar_ember", grant_id: "launch_grant", request_id: id });
  const posted = () => calls.filter(call => call.method === "POST").length;
  const before = posted();currentUser = randomUUID();
  await assert.rejects(claudeConsumeReset(home, id, "launch_grant", identity, fakeFetch), /계정이 변경/);assert.equal(posted(), before);
  currentUser = user;grant = claudeGrant({ resets_left: 0 });
  await assert.rejects(claudeConsumeReset(home, id, "launch_grant", identity, fakeFetch), /사용할 수 없습니다/);assert.equal(posted(), before);
  // Retry replays the identical request after an uncertain answer, even if the reread says already spent.
  result = "already_used";assert.equal(await claudeConsumeReset(home, id, "launch_grant", identity, fakeFetch, true), "alreadyRedeemed");
  for(const [upstream, expected] of [["not_limited","nothingToReset"],["cooldown","cooldown"],["ineligible","noCredit"],["unavailable","unavailable"]]){
    result = upstream;assert.equal(await claudeConsumeReset(home, id, "launch_grant", identity, fakeFetch, true), expected);
  }
  for (const [status, expected] of [[401,"authRequired"],[403,"authRequired"],[429,"rateLimited"]]) {
    httpStatus = status;assert.equal(await claudeConsumeReset(home, id, "launch_grant", identity, fakeFetch, true), expected);
  }
  httpStatus = 200;
  fail = true;await assert.rejects(claudeConsumeReset(home, id, "launch_grant", identity, fakeFetch, true), error => !error.message.includes("secret"));
});

test("Claude reset journal preserves same-id retries and blocks expired uncertain grants without a real network request", async t => {
  const { manager, adapters } = await fixture(t);let calls = 0, quota = parseClaudeQuota({ cedar_ember: claudeGrant() });
  adapters.claude.status = async () => ({ signedIn: true, email: "fixture@example.test", identity: "claude-fixture" });
  adapters.claude.resetIdentity = async () => "claude-fixture";
  adapters.claude.quota = async () => quota;
  adapters.claude.consumeReset = async (_home,key,credit,_native,identity,retry) => {
    assert.equal(identity,"claude-fixture");assert.equal(credit,"launch_grant");calls++;
    assert.equal(retry,calls>1);throw Error("unknown result");
  };
  const prepared = await manager.prepareReset(null,"claude");
  await assert.rejects(manager.consumeReset(prepared.attemptId,null,true), /선택/);assert.equal(calls,0);
  await assert.rejects(manager.consumeReset(prepared.attemptId,"launch_grant",true), /같은 요청/);
  const retry = await manager.prepareReset(null,"claude");assert.equal(retry.pending,true);assert.equal(retry.attemptId,prepared.attemptId);
  await assert.rejects(manager.consumeReset(retry.attemptId,"launch_grant",true), /같은 요청/);assert.equal(calls,2);
  await manager.store.update(state=>{state.resetAttempts["claude-fixture"].submittedAt=new Date(Date.now()-600001).toISOString();});
  await assert.rejects(manager.consumeReset(retry.attemptId,"launch_grant",true), /10분/);assert.equal(calls,2);
  const next = await manager.prepareReset(null,"claude");assert.notEqual(next.attemptId,retry.attemptId);
  assert.match(next.quota.resetCredits.credits[0].blockedReason,/이전 사용 결과/);
  await assert.rejects(manager.consumeReset(next.attemptId,"launch_grant",true), /사용할 수 없습니다/);assert.equal(calls,2);
  quota = parseClaudeQuota({ cedar_ember: claudeGrant({ id: "new_grant" }) });
  const fresh = await manager.prepareReset(null,"claude");assert.equal(fresh.quota.resetCredits.credits[0].status,"available");
});

test("reset countdown shows days/hours/minutes, imminent and elapsed states with deterministic time", () => {
  const now=Date.parse("2026-10-01T00:00:00Z"), at=minutes=>new Date(now+minutes*60000).toISOString();
  assert.equal(formatResetCountdown(at(3*1440+8*60+25),now),"3일 8시간 25분 후");
  assert.equal(formatResetCountdown(at(60),now),"1시간 후");
  assert.equal(formatResetCountdown(at(1),now),"1분 후");
  assert.equal(formatResetCountdown(at(.5),now),"1분 미만 후");
  assert.match(formatResetCountdown(at(0),now),/갱신 대기/);
  assert.equal(formatResetCountdown(null,now),"초기화 시각 미제공");
  assert.equal(formatResetCountdown("invalid",now),"초기화 시각 미제공");
});
