import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseCodexQuota, parseClaudeQuota, parseUsage, claudeQuota, codexQuota, QuotaCache, QuotaError } from "../.test-build/server/usage.js";
import { createAdapters } from "../.test-build/server/adapters.js";
import { AccountManager } from "../.test-build/server/manager.js";
import { SnapshotSchema } from "../.test-build/shared/accounts.js";

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "paseo-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const limit = () => parseCodexQuota({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1790800000 } } }, "pro");
const codexLine = (input, output, cached = 0) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
  last_token_usage: { input_tokens: 8, output_tokens: 4, cached_input_tokens: 0 },
} } }) + "\n";
const claudeLine = (id, output = 4) => JSON.stringify({ type: "assistant", requestId: "request-" + id,
  message: { id, usage: { input_tokens: 8, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }) + "\n";

test("quotas distinguish real durations, missing data, multi-bucket and Claude scoped weekly limits", () => {
  const value = parseCodexQuota({ rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } },
    rateLimitsByLimitId: { codex: {
      primary: { usedPercent: 10, windowDurationMins: 15 },
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1790800000 },
    }, other: { limitName: "모델별", primary: { usedPercent: 110, windowDurationMins: 300 } } } });
  assert.equal(value.windows.length, 3);
  assert.equal(value.windows[0].label, "15분 한도");
  assert.equal(value.windows[1].label, "주간 한도");
  assert.equal(value.windows[2].usedPercent, 100);
  assert.equal(parseCodexQuota({ rateLimits: { primary: { windowDurationMins: 300 } } }).windows.length, 0);
  assert.equal(parseCodexQuota({}).windows.length, 0);
  assert.deepEqual(parseCodexQuota({ rateLimitsByLimitId: {
    reserve: { secondary: { usedPercent: 0, windowDurationMins: 10080 } },
    codex: { primary: { usedPercent: 40, windowDurationMins: 300 }, secondary: { usedPercent: 60, windowDurationMins: 10080 } },
  } }).windows.map(row => row.label), ["5시간 한도", "주간 한도", "주간 한도 · reserve"]);
  const claude = parseClaudeQuota({ five_hour: { utilization: 0, resets_at: "2026-10-01T00:00:00Z" },
    seven_day: null, limits: [{ kind: "weekly_scoped", percent: 42, scope: { model: { id: "sonnet", display_name: "Sonnet" } } }, { kind: "unknown" }] });
  assert.deepEqual(claude.windows.map(row => row.label), ["5시간 한도", "주간 한도 · Sonnet"]);
  assert.equal(claude.windows[0].usedPercent, 0);
  assert.equal(parseClaudeQuota({ five_hour: { utilization: null } }).windows.length, 0);
});

test("Claude uses exact home, readonly credentials, handles auth/rate limits and sanitizes network errors", async t => {
  const root = await temporary(t), home = join(root, "profile"), wrong = join(root, "other");
  await mkdir(home); await mkdir(wrong);
  const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "secret-never-in-ui", subscriptionType: "max" } });
  await writeFile(join(home, ".credentials.json"), credentials);
  const fetchApi = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer secret-never-in-ui");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ seven_day: { utilization: 50, resets_at: null } }), { status: 200 });
  };
  assert.equal((await claudeQuota(home, fetchApi)).windows[0].label, "주간 한도");
  await assert.rejects(claudeQuota(wrong, fetchApi), /인증 정보를 읽을/);
  await assert.rejects(claudeQuota(home, async () => new Response("", { status: 401 })), error => error.status === "auth-required");
  await assert.rejects(claudeQuota(home, async () => new Response("", { status: 429, headers: { "retry-after": "120" } })), error => error.retryAfterMs === 120000);
  await assert.rejects(claudeQuota(home, async () => { throw Error("secret-never-in-ui"); }), error => !error.message.includes("secret-never"));
  assert.equal(await readFile(join(home, ".credentials.json"), "utf8"), credentials);
});

test("Codex quota uses native account RPC and the selected process home", async t => {
  const root = await temporary(t), command = join(root, "codex-fixture");
  await writeFile(command, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const value=JSON.parse(line);if(value.id===undefined)return;
 if(!['initialize','account/read','account/rateLimits/read'].includes(value.method))throw Error('unexpected RPC');
 const result=value.method==='initialize'?{}:value.method==='account/read'?{account:{type:'chatgpt',planType:'pro'}}:
 {rateLimits:{primary:{usedPercent:process.env.CODEX_HOME.endsWith('B')?75:25,windowDurationMins:300}}};
 console.log(JSON.stringify({id:value.id,result}));
});
`, { mode: 0o700 });
  assert.equal((await codexQuota(command, { ...process.env, CODEX_HOME: join(root, "B") })).windows[0].usedPercent, 75);
});

test("quota cache deduplicates, expires at five minutes, retains stale values and honors backoff", async () => {
  let now = 1000, calls = 0;
  const cache = new QuotaCache(() => now);
  const load = async () => { calls++; return limit(); };
  assert.equal(cache.get("account", load).status, "loading");
  cache.get("account", load, true);
  await cache.settled();
  assert.equal(calls, 1);
  assert.equal(cache.get("account", load).status, "available");
  now += 300000; cache.get("account", async () => { calls++; throw new QuotaError("error", "요청 제한", 120000); });
  await cache.settled();
  const stale = cache.get("account", load, true);
  assert.equal(stale.status, "error"); assert.equal(stale.windows[0].usedPercent, 25); assert.equal(calls, 2);
  now += 120000; cache.get("account", load, true); await cache.settled();
  assert.equal(calls, 3); cache.stop();
});

test("native counters include cache once, deduplicate Claude messages and handle Codex resets", () => {
  const claude = parseUsage([claudeLine("one", 2) + claudeLine("one", 4), claudeLine("one", 4) + claudeLine("two")], "claude");
  assert.deepEqual(claude.totals, { inputTokens: 26, outputTokens: 8, cachedInputTokens: 6, cacheWriteInputTokens: 4 });
  assert.equal(claude.complete, true);
  const codex = parseUsage([codexLine(8, 4, 3) + codexLine(8, 4, 3) + codexLine(16, 8, 3) + codexLine(8, 4)], "codex");
  assert.deepEqual(codex.totals, { inputTokens: 24, outputTokens: 12, cachedInputTokens: 3, cacheWriteInputTokens: 0 });
  assert.equal(parseUsage(["{incomplete"], "claude").complete, false);
});

test("per-turn account attribution survives transfers, deferred switch, duplicate events, reload and identity changes", async t => {
  const root = await temporary(t), adapters = createAdapters(), accounts = ["A", "B"].map(label => ({ id: randomUUID(), harness: "codex", label, createdAt: new Date().toISOString() }));
  let newIdentity = false;
  for (const harness of ["codex", "claude"]) {
    adapters[harness].systemHome = join(root, "system-" + harness);
    adapters[harness].quota = async () => limit();
    adapters[harness].status = async home => ({ signedIn: harness === "codex", email: basename(home) + "@example.test",
      identity: harness === "codex" ? basename(home) + (newIdentity && home.endsWith(accounts[1].id) ? "-new" : "") : null });
  }
  const agent = { id: "agent-one", provider: "codex", title: "테스트", status: "idle", activeTurn: null, persistence: { sessionId: randomUUID() } };
  const paseo = { agents: { async list() { return { entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }; },
    ref() { return { async refresh() { return { agent }; } }; } } };
  let manager;
  const restart = async () => { await manager.openSession({ agentId: agent.id, provider: "codex", cwd: root,
    workspaceId: null, reason: "refresh", purpose: "interactive", env: {} }, paseo); };
  manager = new AccountManager({ root: join(root, "accounts"), adapters, restart });
  t.after(() => manager.dispose());
  await manager.store.update(state => { state.accounts.push(...accounts); state.defaults.codex = accounts[0].id; });
  const homeA = manager.profile(accounts[0]), path = join(homeA, "sessions", `rollout-test-${agent.persistence.sessionId}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, codexLine(60, 40)); // Existing CLI usage is baseline only.
  await manager.store.update(state => { state.bindings[agent.id] = { harness: "codex", accountId: accounts[0].id, home: homeA, sessionId: agent.persistence.sessionId, identity: null, generation: "" }; });
  await restart();
  agent.status = "running"; agent.activeTurn = { turnId: "turn-a" };
  await manager.beginTurn(agent.id, "turn-a", paseo);
  await appendFile(path, codexLine(68, 44) + codexLine(76, 48));
  await manager.change({ action: "select", harness: "codex", accountId: accounts[1].id }, paseo);
  assert.equal((await manager.store.read()).bindings[agent.id].accountId, accounts[0].id);
  agent.status = "idle"; agent.activeTurn = null; await manager.endTurn(agent.id, "turn-a", paseo);
  await manager.endTurn(agent.id, "turn-a", paseo);
  let snapshot = await manager.snapshot(paseo);
  assert.equal(snapshot.accounts[0].metrics.statistics.totalTokens, 24);
  assert.equal(snapshot.accounts[1].metrics.statistics.totalTokens, 0);
  assert.equal(snapshot.accounts[0].metrics.isMostRecent, true);
  const pathB = path.replace(homeA, manager.profile(accounts[1]));
  agent.status = "running"; agent.activeTurn = { turnId: "turn-a" };
  await manager.beginTurn(agent.id, "turn-a", paseo); await manager.beginTurn(agent.id, "turn-a", paseo);
  await appendFile(pathB, codexLine(84, 52));
  manager.dispose(); manager = new AccountManager({ root: join(root, "accounts"), adapters, restart });
  agent.status = "idle"; agent.activeTurn = null; await manager.endTurn(agent.id, "turn-a", paseo);
  snapshot = await manager.snapshot(paseo); SnapshotSchema.parse(snapshot);
  assert.equal(snapshot.accounts[1].metrics.statistics.totalTokens, 12);
  assert.equal(snapshot.accounts[1].metrics.statistics.turns, 1);
  assert.equal(snapshot.accounts[1].metrics.statistics.incompleteTurns, 0);
  assert.equal(snapshot.accounts[1].metrics.isMostRecent, true);
  await manager.change({ action: "select", harness: "codex", accountId: accounts[0].id }, paseo);
  assert.equal((await manager.snapshot(paseo)).accounts[1].metrics.isMostRecent, true); // Selection is not use.
  newIdentity = true;
  snapshot = await manager.snapshot(paseo);
  assert.equal(snapshot.accounts[1].metrics.statistics.totalTokens, 0);
  assert.equal(snapshot.accounts[1].metrics.isMostRecent, false);
  const persisted = await readFile(join(manager.store.root, "metadata.json"), "utf8");
  assert.equal(JSON.parse(persisted).version, 3);
  assert.ok(!persisted.includes("access_token"));
  assert.ok(!JSON.stringify(snapshot).includes("identity"));
});

test("version-one migration preserves account selection and rejects raw errors containing secrets", async t => {
  const root = await temporary(t), id = randomUUID(), adapters = createAdapters();
  for (const harness of ["codex", "claude"]) adapters[harness].status = async () => ({ signedIn: false, email: null, identity: null });
  await writeFile(join(root, "metadata.json"), JSON.stringify({ version: 1,
    accounts: [{ id, harness: "codex", label: "기존 계정", createdAt: new Date().toISOString() }],
    defaults: { codex: id, claude: null }, overrides: {}, bindings: {}, pending: {} }));
  const manager = new AccountManager({ root, adapters }); t.after(() => manager.dispose());
  const paseo = { agents: { async list() { return { entries: [], pageInfo: { hasMore: false, nextCursor: null } }; } } };
  const snapshot = await manager.snapshot(paseo);
  assert.equal(snapshot.defaults.codex, id); assert.equal(snapshot.accounts[0].metrics.statistics.turns, 0);
  const metadata = JSON.parse(await readFile(join(root, "metadata.json"), "utf8"));
  assert.equal(metadata.version, 3); assert.ok(metadata.usage.startedAt);
  assert.ok(!manager.publicError(Error("access_token secret-token")).includes("secret-token"));
});

test("Claude system-account turns include subagents, exclude old CLI records and retain partial usage on failure", async t => {
  const root = await temporary(t), adapters = createAdapters();
  for (const harness of ["codex", "claude"]) {
    adapters[harness].systemHome = join(root, harness);
    adapters[harness].status = async () => ({ signedIn: harness === "claude", email: harness === "claude" ? "outside@example.test" : null,
      identity: harness === "claude" ? "claude-system-identity" : null });
    adapters[harness].quota = async () => parseClaudeQuota({ five_hour: { utilization: 42 } });
  }
  const sessionId = randomUUID(), home = adapters.claude.systemHome;
  const path = join(home, "projects", "-test", sessionId + ".jsonl");
  await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, claudeLine("old-cli"));
  const agent = { id: "claude-agent", provider: "claude", title: "Claude", status: "idle", persistence: { sessionId }, activeTurn: null };
  const paseo = { agents: { async list() { return { entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }; },
    ref() { return { async refresh() { return { agent }; } }; } } };
  const manager = new AccountManager({ root: join(root, "accounts"), adapters }); t.after(() => manager.dispose());
  const opened = await manager.openSession({ agentId: agent.id, provider: "claude", cwd: root, workspaceId: null,
    reason: "resume", purpose: "interactive", env: { PRESERVED: "yes" } }, paseo);
  assert.equal(opened.env.PRESERVED, "yes");
  agent.status = "running"; agent.activeTurn = { turnId: "claude-turn-0" };
  await manager.beginTurn(agent.id, "claude-turn-0", paseo);
  await appendFile(path, claudeLine("new-root", 2) + claudeLine("new-root", 4));
  const child = join(home, "projects", "-test", sessionId, "subagents", "agent-child.jsonl");
  await mkdir(join(child, ".."), { recursive: true }); await writeFile(child, claudeLine("new-child") + claudeLine("new-child"));
  agent.status = "idle"; agent.activeTurn = null; await manager.endTurn(agent.id, "claude-turn-0", paseo);
  let statistics = (await manager.snapshot(paseo)).systemAccounts.find(row => row.harness === "claude").metrics.statistics;
  assert.equal(statistics.totalTokens, 34); assert.equal(statistics.inputTokens, 26);
  assert.equal(statistics.cachedInputTokens, 6); assert.equal(statistics.cacheWriteInputTokens, 4);
  assert.equal(statistics.turns, 1); assert.equal(statistics.incompleteTurns, 0);
  agent.status = "running"; agent.activeTurn = { turnId: "claude-turn-1" };
  await manager.beginTurn(agent.id, "claude-turn-1", paseo);
  await appendFile(path, claudeLine("failed-request") + "{incomplete-tail");
  agent.status = "error"; agent.activeTurn = null; await manager.endTurn(agent.id, "claude-turn-1", paseo);
  await manager.endTurn(agent.id, "claude-turn-1", paseo);
  statistics = (await manager.snapshot(paseo)).systemAccounts.find(row => row.harness === "claude").metrics.statistics;
  assert.equal(statistics.totalTokens, 51); assert.equal(statistics.turns, 2); assert.equal(statistics.incompleteTurns, 1);
});

test("Codex metadata process aborts cleanly and does not expose child stderr", async t => {
  const root = await temporary(t), command = join(root, "hanging-codex");
  await writeFile(command, "#!/usr/bin/env node\nconsole.error('access_token secret-value');setInterval(()=>{},1000);\n", { mode: 0o700 });
  const controller = new AbortController();
  const running = codexQuota(command, { ...process.env }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, error => !error.message.includes("secret-value") && error.status === "error");
});

test("an existing idle system session is primed before its first post-update turn", async t => {
  const root = await temporary(t), adapters = createAdapters(), sessionId = randomUUID();
  for (const harness of ["codex", "claude"]) {
    adapters[harness].systemHome = join(root, harness);
    adapters[harness].status = async () => ({ signedIn: harness === "codex", email: harness === "codex" ? "system@example.test" : null,
      identity: harness === "codex" ? "system-codex" : null });
    adapters[harness].quota = async () => limit();
  }
  const path = join(adapters.codex.systemHome, "sessions", `rollout-test-${sessionId}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, codexLine(60, 40));
  const agent = { id: "existing-agent", provider: "codex", title: "기존 세션", status: "idle", activeTurn: null, persistence: { sessionId } };
  const paseo = { agents: { async list() { return { entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }; },
    ref() { return { async refresh() { return { agent }; } }; } } };
  const manager = new AccountManager({ root: join(root, "accounts"), adapters }); t.after(() => manager.dispose());
  await manager.snapshot(paseo);
  agent.status = "running"; agent.activeTurn = { turnId: "codex-turn-7" };
  await manager.beginTurn(agent.id, "codex-turn-7", paseo); await appendFile(path, codexLine(68, 44));
  agent.status = "idle"; agent.activeTurn = null; await manager.endTurn(agent.id, "codex-turn-7", paseo);
  const usage = (await manager.snapshot(paseo)).systemAccounts.find(row => row.harness === "codex").metrics;
  assert.equal(usage.statistics.totalTokens, 12); assert.equal(usage.statistics.incompleteTurns, 0);
  assert.equal(usage.isMostRecent, true);
});

test("Claude renews expired credentials once across concurrent reads and preserves other credentials", async t => {
  const home = await temporary(t), path = join(home, ".credentials.json");
  await writeFile(path, JSON.stringify({ mcpOAuth: { keep: "unchanged" }, claudeAiOauth: {
    accessToken: "old-private-access", refreshToken: "old-private-refresh", expiresAt: 1,
    scopes: ["user:profile", "user:inference"], subscriptionType: "max", rateLimitTier: "preserved",
  } }));
  let renewals = 0;
  const fetchApi = async (url, options) => {
    if (url.endsWith("/v1/oauth/token")) {
      renewals++;
      assert.equal(options.redirect, "error");
      const body = JSON.parse(options.body);
      assert.equal(body.grant_type, "refresh_token");
      assert.equal(body.refresh_token, "old-private-refresh");
      assert.equal(body.scope, "user:profile user:inference");
      await new Promise(r => setTimeout(r, 50));
      return new Response(JSON.stringify({ access_token: "new-private-access", refresh_token: "new-private-refresh", expires_in: 28800, refresh_token_expires_in: 2592000 }));
    }
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer new-private-access");
    return new Response(JSON.stringify({ five_hour: { utilization: 20 } }));
  };
  const quotas = await Promise.all([claudeQuota(home, fetchApi), claudeQuota(home, fetchApi)]);
  assert.equal(renewals, 1);
  assert(quotas.every(q => q.status === "available"));
  assert(!JSON.stringify(quotas).includes("private"));
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.mcpOAuth.keep, "unchanged");
  assert.equal(stored.claudeAiOauth.rateLimitTier, "preserved");
  assert(stored.claudeAiOauth.expiresAt > Date.now());
  assert(stored.claudeAiOauth.refreshTokenExpiresAt > stored.claudeAiOauth.expiresAt);
  const { lstat } = await import("node:fs/promises");
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await assert.rejects(lstat(join(home, ".oauth_refresh.lock")), { code: "ENOENT" });
  await assert.rejects(lstat(home + ".lock"), { code: "ENOENT" });
});

test("Claude retries a rejected token once but keeps permission errors separate from login expiry", async t => {
  const home = await temporary(t), path = join(home, ".credentials.json");
  const credentials = () => JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + 3600000 } });
  await writeFile(path, credentials());
  let reads = 0, renewals = 0;
  const fetchApi = async (url, options) => {
    if (url.endsWith("/v1/oauth/token")) { renewals++; return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800 })); }
    reads++;
    return options.headers.Authorization === "Bearer old-access" ? new Response("", { status: 401 }) : new Response(JSON.stringify({ seven_day: { utilization: 30 } }));
  };
  assert.equal((await claudeQuota(home, fetchApi)).status, "available");
  assert.equal(reads, 2); assert.equal(renewals, 1);
  const before = await readFile(path, "utf8"); let forbiddenCalls = 0;
  await assert.rejects(claudeQuota(home, async (_, options) => {
    forbiddenCalls++; assert.equal(options.method, "GET"); return new Response("permission denied", { status: 403 });
  }), e => e.status === "error" && !e.message.includes("다시 로그인"));
  assert.equal(forbiddenCalls, 1); assert.equal(await readFile(path, "utf8"), before);
});

test("only rejected refresh grants require relogin; transient renewal errors preserve credentials", async t => {
  const home = await temporary(t), path = join(home, ".credentials.json");
  const before = JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: "private-refresh", expiresAt: 1 } });
  await writeFile(path, before);
  for (const [code, error, status] of [[400, "invalid_grant", "auth-required"], [503, "unavailable", "error"]]) {
    await assert.rejects(claudeQuota(home, async (url, options) => {
      assert(url.endsWith("/v1/oauth/token")); assert.equal(options.method, "POST");
      return new Response(JSON.stringify({ error, error_description: "private-refresh" }), { status: code });
    }), e => e.status === status && !e.message.includes("private-refresh"));
    assert.equal(await readFile(path, "utf8"), before);
  }
});

test("Codex recovers a quota 401 through native account refresh without a login or model request", async t => {
  const root = await temporary(t), command = join(root, "codex-refresh-fixture"), trace = join(root, "calls.jsonl");
  await writeFile(command, `#!/usr/bin/env node
const fs=require('node:fs');let fresh=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);if(v.id===undefined)return;
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({method:v.method,params:v.params})+'\\n');
 if(!['initialize','account/read','account/rateLimits/read'].includes(v.method))throw Error('unexpected operation');
 if(v.method==='account/read'&&v.params.refreshToken)fresh=true;
 const result=v.method==='initialize'?{}:v.method==='account/read'?{account:{type:'chatgpt',planType:'pro'}}:{rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}};
 console.log(JSON.stringify(v.method==='account/rateLimits/read'&&!fresh?{id:v.id,error:{code:401,message:'Unauthorized'}}:{id:v.id,result}));
});
`, { mode: 0o700 });
  assert.equal((await codexQuota(command, process.env)).status, "available");
  const calls = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.filter(c => c.method === "account/read").map(c => c.params.refreshToken), [false, true]);
  assert.equal(calls.filter(c => c.method === "account/rateLimits/read").length, 2);
});

test("failed login-state lookups and recovered old login errors do not ask a valid account to login again", async t => {
  const root = await temporary(t), adapters = createAdapters(), id = randomUUID();
  for (const h of ['codex','claude']) adapters[h].status = async () => { throw Error('lookup failed'); };
  const manager = new AccountManager({root, adapters});t.after(()=>manager.dispose());
  await manager.store.update(s=>s.accounts.push({id,harness:'claude',label:'A',createdAt:new Date().toISOString()}));
  const paseo={agents:{async list(){return {entries:[],pageInfo:{hasMore:false,nextCursor:null}};}}};
  let snapshot=await manager.snapshot(paseo);
  assert.equal(snapshot.accounts[0].status,'error');assert(!snapshot.accounts[0].metrics.quota.error.includes('로그인하면'));
  assert(snapshot.systemAccounts.every(r=>!r.metrics.quota.error.includes('로그인하면')));
  adapters.claude.status=async()=>({signedIn:true,email:'fixture@example.test',identity:'e'.repeat(64)});
  adapters.claude.quota=async()=>parseClaudeQuota({});
  manager.loginErrors.set(id,'다시 로그인하세요.');manager.loginErrors.set('system:claude','다시 로그인하세요.');
  snapshot=await manager.snapshot(paseo);
  assert.equal(snapshot.accounts[0].status,'signed-in');assert.equal(snapshot.accounts[0].error,null);
  assert.equal(snapshot.systemAccounts.find(r=>r.harness==='claude').error,null);
});

test('persisted quota values and Retry-After survive reload without native queries or secrets', async t => {
  const root = await temporary(t), file = join(root, 'quota-cache.json'); let now = 1000, calls = 0;
  const cache = new QuotaCache(() => now); await cache.restore(file);
  cache.get('claude:profile:identity', async () => { calls++; return limit(); }); await cache.settled();
  now += 300001;
  cache.get('claude:profile:identity', async () => { calls++; throw new QuotaError('error', '한도 조회 요청이 많습니다.', 120000); }); await cache.settled();
  const saved = JSON.parse(await readFile(file, 'utf8')); assert.equal(saved['claude:profile:identity'].value.windows[0].usedPercent, 25);
  cache.stop(); const restored = new QuotaCache(() => now); await restored.restore(file); t.after(() => restored.stop());
  const load = async () => { calls++; return limit(); };
  const value = restored.get('claude:profile:identity', load, true);
  assert.equal(value.status, 'error'); assert.equal(value.retryAt, new Date(now + 120000).toISOString());
  await assert.rejects(restored.read('claude:profile:identity', load), error => error.retryAfterMs === 120000);
  assert.equal(calls, 2); now += 120000; assert.equal((await restored.read('claude:profile:identity', load)).status, 'available'); assert.equal(calls, 3);
});
test('fresh safety reads share in-flight queries and keep upstream backoff despite forced refresh', async () => {
  let now = 0, calls = 0, release; const cache = new QuotaCache(() => now);
  const load = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = cache.read('profile', load), second = cache.read('profile', load);
  await new Promise(setImmediate); assert.equal(calls, 1); release(limit()); await Promise.all([first, second]);
  const failed = async () => { calls++; throw new QuotaError('error', 'private-token-secret', 60000); };
  await assert.rejects(cache.read('profile', failed), /한도를 조회하지/);
  for (let i = 0; i < 10; i++) { cache.get('profile', load, true); await assert.rejects(cache.read('profile', load)); }
  assert.equal(calls, 2); assert.ok(!JSON.stringify(cache.get('profile', load)).includes('private-token-secret')); cache.stop();
});

test('server retry deadlines never slide when the UI polls, force-refreshes, or a safety read is blocked', async () => {
 let now=1000,calls=0;const cache=new QuotaCache(()=>now);
 const load=async()=>{calls++;throw new QuotaError('error','Claude 서버가 사용량 조회를 제한하고 있습니다(HTTP 429).',3600000,{kind:'rate-limited',retrySource:'server'});};
 cache.get('profile',load);await cache.settled();const initial=cache.get('profile',load);
 assert.equal(initial.failureCode,'rate-limited');assert.equal(initial.retrySource,'server');assert.equal(initial.attemptedAt,new Date(1000).toISOString());
 for(let i=0;i<24;i++){now+=120000;assert.equal(cache.get('profile',load,i%2===0).retryAt,initial.retryAt);await assert.rejects(cache.read('profile',load),e=>e.info.retrySource==='server');}
 assert.equal(calls,1);assert.equal(cache.get('profile',load).attemptedAt,initial.attemptedAt);
 now=3601000;cache.get('profile',load);await cache.settled();const second=cache.get('profile',load);
 assert.equal(calls,2);assert.notEqual(second.attemptedAt,initial.attemptedAt);assert.equal(second.retryAt,new Date(now+3600000).toISOString());cache.stop();
});
test('native 429 diagnostics separate upstream Retry-After from local fallback without exposing credentials',async t=>{
 const root=await temporary(t);await writeFile(join(root,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'private-secret'}}));
 for(const header of ['3600','0'])await assert.rejects(claudeQuota(root,async()=>new Response('',{status:429,headers:{'retry-after':header}})),e=>{
  assert.equal(e.info.kind,'rate-limited');assert.equal(e.info.retrySource,header==='3600'?'server':'local');assert.match(e.message,/HTTP 429/);assert.ok(!e.message.includes('private-secret'));return true;
 });
});
test('schema failures are identifiable without serializing raw validation data',async()=>{
 const cache=new QuotaCache(()=>1000);cache.get('profile',async()=>({status:'private-token-secret'}));await cache.settled();
 const q=cache.get('profile',async()=>{throw Error('unused');});assert.equal(q.failureCode,'response');assert.equal(q.retrySource,'local');assert.match(q.error,/응답 형식/);assert.ok(!JSON.stringify(q).includes('private-token-secret'));cache.stop();
});

test('managed Claude OAuth status reads local identity without starting CLI and respects config auth overrides',async t=>{
 const root=await temporary(t),marker=join(root,'cli-started'),command=join(root,'claude-status');
 await writeFile(command,`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)},'called\\n');console.log(JSON.stringify({loggedIn:false}));\n`,{mode:0o700});
 const credential=JSON.stringify({claudeAiOauth:{accessToken:'private-secret',expiresAt:Date.now()+3600000,refreshToken:'private-refresh'}});
 const info={accountUuid:randomUUID(),organizationUuid:randomUUID(),emailAddress:'local@example.test'};
 await writeFile(join(root,'.credentials.json'),credential);await writeFile(join(root,'.claude.json'),JSON.stringify({oauthAccount:info}));await writeFile(join(root,'settings.json'),'{}');
 const adapter=createAdapters({claude:command}).claude;
 const first=await adapter.status(root);assert.equal(first.signedIn,true);assert.equal(first.email,info.emailAddress);
 await assert.rejects(readFile(marker),e=>e.code==='ENOENT');assert.ok(!JSON.stringify(first).includes('private-'));
 info.accountUuid=randomUUID();await writeFile(join(root,'.claude.json'),JSON.stringify({oauthAccount:info}));assert.notEqual((await adapter.status(root)).identity,first.identity);
 await writeFile(join(root,'settings.json'),JSON.stringify({env:{ANTHROPIC_API_KEY:'fixture-key'}}));assert.equal((await adapter.status(root)).signedIn,false);assert.equal(await readFile(marker,'utf8'),'called\n');
 assert.equal(await readFile(join(root,'.credentials.json'),'utf8'),credential);
});
