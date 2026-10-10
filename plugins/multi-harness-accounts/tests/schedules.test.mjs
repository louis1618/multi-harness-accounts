import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccountManager, isUsageLimitFailure } from '../.test-build/server/manager.js';
import { ScheduleManager, resetFor } from '../.test-build/server/schedules.js';
import { parseCodexQuota, parseClaudeQuota, QuotaError } from '../.test-build/server/usage.js';
import { emptyTokens } from '../.test-build/shared/accounts.js';
import { localDateTime, parseLocalDateTime, changeSchedule } from '../.test-build/shared/schedules.js';

const NOW = Date.parse('2026-10-04T00:00:00.000Z');
const failure = { outcome: { kind: 'failed', error: { code: 'usage_limit_reached', message: "You've hit your usage limit" } }, timeline: [] };
const quota = (used, resets = NOW + 3600000) => parseCodexQuota({ rateLimits: { primary: { usedPercent: used, windowDurationMins: 300, resetsAt: resets / 1000 } } });
async function fixture(t, harness = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'paseo-schedule-')); t.after(() => rm(root, { recursive: true, force: true }));
  let clock = NOW, q = quota(0), signedIn = true, identity = 'identity-A', sendHook, history = [];
  const account = { id: randomUUID(), harness, label: 'A', createdAt: new Date(NOW).toISOString() };
  const adapter = { systemHome: root, status: async () => ({ signedIn, identity, email: 'fixture@example.test' }), quota: async () => { if (q instanceof Error) throw q; return typeof q === 'function' ? q() : q; } };
  const manager = new AccountManager({ root, adapters: { codex: adapter, claude: adapter }, now: () => clock }); t.after(() => manager.dispose());
  const agent = { id: 'fixture-agent', title: 'Fixture', provider: harness, model: harness === 'codex' ? 'gpt-6' : 'claude-sonnet-4', status: 'idle', activeTurn: null,
    lastUserMessageAt: new Date(NOW - 1000).toISOString(), persistence: { sessionId: 'native-session' }, pendingPermissions: [] };
  await manager.store.update(s => {
    s.accounts = [account]; s.defaults[harness] = account.id;
    s.bindings[agent.id] = { harness, accountId: account.id, home: root, sessionId: 'native-session', identity, generation: 'generation-A' };
  });
  const cards = new Map(), receipts = new Map(), sent = [], calls = [];
  const handle = {
    refresh: async () => ({ agent }), subscribe: () => () => {},
    timeline: { append: async row => { cards.set(row.id, row.data); return { seq: 1, epoch: 'fixture' }; },
      refetch: async () => ({ entries: [...[...receipts].map(([id, text]) => ({ item: { type: 'user_message', clientMessageId: id, text } })), ...history.map(item => ({ item }))] }) },
    send: async (text, options) => {
      calls.push(options);
      if (receipts.has(options.messageId)) return;
      assert.equal(agent.activeTurn, null); assert.equal(agent.pendingPermissions.length, 0);
      assert.equal(options.sendGuard.lastUserMessageAt, agent.lastUserMessageAt);
      assert.equal(options.sendGuard.provider, agent.provider); assert.equal(options.sendGuard.sessionId, agent.persistence.sessionId);
      if (sendHook) await sendHook(text, options);
      receipts.set(options.messageId, text); sent.push(text); agent.lastUserMessageAt = new Date(clock).toISOString();
    },
  };
  const paseo = { agents: { ref: () => handle } };
  const scheduler = new ScheduleManager(manager, () => clock); await scheduler.start(paseo, true); t.after(() => scheduler.dispose());
  const tick = async () => { await scheduler.kick(); await scheduler.kick(); };
  const jobs = async () => Object.values((await manager.store.read()).schedules.jobs);
  const reserve = (message = 'Continue', delay = 1000) => scheduler.change({ action: 'save', agentId: agent.id, message, dueAt: new Date(clock + delay).toISOString() });
  await tick();
  return { root, manager, scheduler, paseo, agent, account, sent, cards, receipts, calls, tick, jobs, reserve,
    advance: value => { clock += value; }, setQuota: value => { q = value; }, setHistory: value => { history = value; }, setAuth: (signed, who = identity) => { signedIn = signed; identity = who; }, setSend: value => { sendHook = value; }, now: () => clock };
}
test('recognizes native Claude session-limit notices while excluding temporary request rate limits', () => {
  for (const text of ["You've hit your session limit · resets 6:10am (Asia/Seoul)", 'You’ve hit your weekly limit', "You're out of extra usage", "You've hit your 5-hour limit"]) {
    assert.equal(isUsageLimitFailure({ outcome: { kind: 'completed' }, timeline: [{ type: 'assistant_message', text }] }), true);
    assert.equal(isUsageLimitFailure({ outcome: { kind: 'failed', error: { code: 'rate_limit', message: text } }, timeline: [] }), true);
  }
  assert.equal(isUsageLimitFailure({ outcome: { kind: 'failed', error: { code: 'rate_limit', message: 'Too many requests. Try again in 5 seconds.' } }, timeline: [] }), false);
  assert.equal(isUsageLimitFailure({ outcome: { kind: 'completed' }, timeline: [{ type: 'assistant_message', text: "The logs contain: You've hit your session limit" }] }), false);
});
test('time input round-trips locally and rejects overflow dates and malformed RPC input', () => {
  const iso = new Date(NOW).toISOString(), parts = localDateTime(iso);
  assert.equal(parseLocalDateTime(parts.date, parts.time), iso);
  assert.equal(parseLocalDateTime('2026-02-30', '10:00'), null);
  assert.equal(parseLocalDateTime('2026-10-04', '24:10'), null);
  assert.throws(() => changeSchedule.input.parse({ action: 'save', agentId: 'fixture-agent', message: '', dueAt: iso }));
});
test('uses the earliest provided five-hour or weekly reset regardless of exhaustion', () => {
  const q = parseClaudeQuota({ five_hour: { utilization: 100, resets_at: new Date(NOW + 1000).toISOString() },
    seven_day: { utilization: 100, resets_at: new Date(NOW + 2000).toISOString() },
    seven_day_opus: { utilization: 100, resets_at: new Date(NOW + 99999).toISOString() } });
  assert.equal(resetFor(q, 'claude-sonnet-4', NOW).at, new Date(NOW + 1000).toISOString());
  q.windows[0].usedPercent = 20; assert.equal(resetFor(q, 'claude-sonnet-4', NOW).at, new Date(NOW + 1000).toISOString());
  q.windows[1].resetsAt = new Date(NOW + 500).toISOString(); assert.equal(resetFor(q, 'claude-sonnet-4', NOW).at, new Date(NOW + 500).toISOString());
  q.windows[0].resetsAt = null; assert.equal(resetFor(q, 'claude-sonnet-4', NOW).at, new Date(NOW + 500).toISOString());
  q.windows[1].resetsAt = new Date(NOW).toISOString(); assert.equal(resetFor(q, 'claude-sonnet-4', NOW).at, null);
  const other = parseCodexQuota({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: (NOW + 1000) / 1000 } } });
  assert.equal(other.windows[0].durationMinutes, 60); assert.equal(resetFor(other, 'gpt-6', NOW).at, null);
  const codex = parseCodexQuota({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: (NOW + 1000) / 1000 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: (NOW + 2000) / 1000 } } });
  assert.equal(resetFor(codex, 'gpt-6', NOW).at, new Date(NOW + 1000).toISOString());
  assert.equal(resetFor(codex, 'gpt-6', NOW).blocked, true);
});
test('each session uses its own harness adapter and running account, with separate quota caches', async t => {
  const f = await fixture(t), calls = [], claude = { ...f.agent, id: 'claude-session', provider: 'claude', model: 'claude-sonnet-4' };
  const claudeAccount = { ...f.account, id: randomUUID(), harness: 'claude', label: 'Claude B' };
  const otherCodex = { ...f.account, id: randomUUID(), label: 'Different default' };
  await f.manager.store.update(s => {
    s.accounts.push(claudeAccount, otherCodex); s.defaults.codex = otherCodex.id; s.defaults.claude = claudeAccount.id;
    s.bindings[claude.id] = { ...s.bindings[f.agent.id], harness: 'claude', accountId: claudeAccount.id };
  });
  const ref = f.paseo.agents.ref;
  f.paseo.agents.ref = id => id === claude.id ? { ...ref(id), refresh: async () => ({ agent: claude }) } : ref(id);
  f.manager.adapters.codex = { ...f.manager.adapters.codex, quota: async (home, native) => { calls.push(['codex', home, native]); return quota(100, NOW + 1000); } };
  f.manager.adapters.claude = { ...f.manager.adapters.claude, quota: async (home, native) => { calls.push(['claude', home, native]); return parseClaudeQuota({ five_hour: { utilization: 100, resets_at: new Date(NOW + 2000).toISOString() } }); } };
  await f.scheduler.list(f.agent.id); await f.scheduler.list(claude.id); await new Promise(setImmediate);
  const a = await f.scheduler.list(f.agent.id), b = await f.scheduler.list(claude.id);
  assert.equal(a.defaultAt, new Date(NOW + 1000).toISOString()); assert.equal(b.defaultAt, new Date(NOW + 2000).toISOString());
  assert.deepEqual(a.context, { harness: 'codex', accountLabel: 'A' }); assert.deepEqual(b.context, { harness: 'claude', accountLabel: 'Claude B' });
  assert.deepEqual(calls, [['codex', f.root, false], ['claude', f.root, false]]);
});
test('a running system account stays native even when a different global default is selected', async t => {
  const f = await fixture(t), calls = [], systemHome = join(f.root, 'system');
  await f.manager.store.update(s => { s.bindings[f.agent.id].accountId = null; s.bindings[f.agent.id].home = systemHome; });
  f.manager.adapters.codex = { ...f.manager.adapters.codex, systemHome, quota: async (home, native) => { calls.push([home, native]); return quota(10, NOW + 1000); } };
  await f.scheduler.list(f.agent.id); await new Promise(setImmediate); const result = await f.scheduler.list(f.agent.id);
  assert.deepEqual(result.context, { harness: 'codex', accountLabel: '시스템 계정' });
  assert.deepEqual(calls, [[systemHome, true]]); assert.equal(result.defaultAt, new Date(NOW + 1000).toISOString());
});
test('a changed harness does not reuse the previous harness profile directory', async t => {
  const f = await fixture(t), calls = [], account = { ...f.account, id: randomUUID(), harness: 'claude', label: 'Claude B' };
  f.agent.provider = 'claude'; f.agent.model = 'claude-sonnet-4';
  await f.manager.store.update(s => { s.accounts.push(account); s.defaults.claude = account.id; });
  f.manager.adapters.claude = { ...f.manager.adapters.claude, quota: async (home, native) => { calls.push([home, native]); return quota(0, NOW + 2000); } };
  await f.scheduler.list(f.agent.id); await new Promise(setImmediate); const result = await f.scheduler.list(f.agent.id);
  assert.deepEqual(result.context, { harness: 'claude', accountLabel: 'Claude B' });
  assert.deepEqual(calls, [[f.manager.profile(account), false]]); assert.equal(result.defaultAt, new Date(NOW + 2000).toISOString());
});
test('the earliest reset never submits while the other applicable limit is still exhausted', async t => {
  const f = await fixture(t), weekly = new Date(NOW + 2000).toISOString();
  f.setQuota(parseCodexQuota({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: (NOW + 1000) / 1000 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: (NOW + 2000) / 1000 } } }));
  await f.reserve(); f.advance(1000); await f.tick();
  assert.equal(f.sent.length, 0); assert.equal((await f.jobs())[0].dueAt, weekly);
  f.setQuota(quota(0)); f.advance(1000); await f.tick(); assert.equal(f.sent.length, 1);
});
test('persists one pending message, immediately renders the card, edits it, and sends exactly once', async t => {
  const f = await fixture(t); await f.reserve('finish the requested work');
  let [job] = await f.jobs(); assert.equal(f.cards.get(job.id).message, 'finish the requested work'); assert.equal(f.sent.length, 0);
  await f.reserve('Continue with verification', 2000); assert.equal((await f.jobs()).length, 1);
  const revised = (await f.jobs())[0]; assert.equal(revised.id, job.id); assert.notEqual(revised.messageId, job.messageId);
  f.advance(1999); await f.tick(); assert.equal(f.sent.length, 0);
  f.advance(1); await f.tick(); assert.deepEqual(f.sent, ['Continue with verification']);
  await f.tick(); assert.equal(f.sent.length, 1); assert.equal((await f.jobs())[0].status, 'sent');
});
test('busy and permission-waiting sessions retain their work and send only after it finishes', async t => {
  const f = await fixture(t); await f.reserve(); f.advance(1000);
  f.agent.activeTurn = { turnId: 'existing-turn' }; f.agent.status = 'running'; await f.tick(); assert.equal(f.sent.length, 0);
  f.advance(30000); f.agent.activeTurn = null; f.agent.status = 'idle'; f.agent.pendingPermissions = [{ id: 'approval' }];
  await f.tick(); assert.equal(f.sent.length, 0); assert.equal(f.agent.pendingPermissions.length, 1);
  f.agent.pendingPermissions = []; f.advance(30000); await f.tick(); assert.equal(f.sent.length, 1);
});
test('new user input and account changes cancel old reservations', async t => {
  const f = await fixture(t); await f.reserve(); f.agent.lastUserMessageAt = new Date(NOW + 100).toISOString();
  await f.scheduler.turnStarted(f.agent.id); assert.equal((await f.jobs())[0].status, 'canceled');
  await f.reserve(); await f.manager.store.update(s => { s.defaults.codex = null; }); f.advance(1000); await f.tick();
  assert.equal(f.sent.length, 0); assert.ok((await f.jobs()).every(j => j.status === 'canceled'));
});
test('exhausted quota postpones until actual reset, then resumes once', async t => {
  const f = await fixture(t); await f.reserve(); f.setQuota(quota(100, NOW + 60000)); f.advance(1000); await f.tick();
  const [job] = await f.jobs(); assert.equal(job.dueAt, new Date(NOW + 60000).toISOString()); assert.equal(f.sent.length, 0);
  f.setQuota(quota(0)); f.advance(59000); await f.tick(); assert.equal(f.sent.length, 1);
});
test('unknown reset and expired auth need attention; transient quota errors retry without exposing native errors', async t => {
  const f = await fixture(t); await f.reserve(); const q = quota(100); q.windows[0].resetsAt = null; f.setQuota(q); f.advance(1000); await f.tick();
  assert.equal((await f.jobs())[0].status, 'attention'); assert.equal(f.sent.length, 0);
  f.setQuota(new QuotaError('error', 'private-token-secret')); await f.reserve(); f.advance(1000); await f.tick();
  assert.equal((await f.jobs()).at(-1).status, 'waiting'); assert.ok(!JSON.stringify(await f.jobs()).includes('private-token-secret'));
  f.setQuota(quota(0)); f.setAuth(false); f.advance(60000); await f.tick(); assert.equal((await f.jobs()).at(-1).status, 'attention');
});
test('restart without a frontend restores jobs; 24 hour catch-up expires older jobs', async t => {
  const f = await fixture(t); await f.reserve(); f.scheduler.dispose(); f.advance(8 * 3600000);
  const restored = new ScheduleManager(f.manager, f.now); t.after(() => restored.dispose()); restored.start(f.paseo, true);
  await restored.kick(); assert.equal(f.sent.length, 1);
  const g = await fixture(t); await g.reserve(); g.advance(86400000 + 1001); await g.tick();
  assert.equal(g.sent.length, 0); assert.equal((await g.jobs())[0].status, 'attention');
});
test('host guard rejects a racing run without losing the reservation or clearing permissions', async t => {
  const f = await fixture(t); await f.reserve(); f.advance(1000);
  f.setSend(() => { f.agent.activeTurn = { turnId: 'race' }; throw Error('SCHEDULE_GUARD_BUSY'); }); await f.tick();
  assert.equal(f.sent.length, 0); assert.equal((await f.jobs())[0].status, 'waiting');
  f.setSend(null); f.agent.activeTurn = null; f.advance(30000); await f.tick(); assert.equal(f.sent.length, 1);
});
test('unknown acknowledgement reconciles canonical message; unknown receipt is never resent automatically', async t => {
  const f = await fixture(t); await f.reserve(); f.advance(1000);
  f.setSend((text, options) => { f.receipts.set(options.messageId, text); throw Error('transport-disconnected'); }); await f.tick(); await f.tick();
  assert.equal(f.calls.length, 1); assert.equal((await f.jobs())[0].status, 'sent');
  const g = await fixture(t); await g.reserve(); g.advance(1000); g.setSend(() => { throw Error('outcome-unknown'); }); await g.tick(); await g.tick();
  assert.equal(g.calls.length, 1); assert.equal((await g.jobs())[0].status, 'attention');
});
test('automatic reset reservations are opt-in and independent of account rotation', async t => {
  const f = await fixture(t); f.setQuota(quota(100)); await f.scheduler.turnEnded(f.agent.id, failure, 'off'); assert.equal((await f.jobs()).length, 0);
  await f.scheduler.change({ action: 'automatic', agentId: f.agent.id, enabled: true });
  await f.scheduler.turnEnded(f.agent.id, failure, 'on'); await f.scheduler.turnEnded(f.agent.id, failure, 'on'); assert.equal((await f.jobs()).length, 1);
  await f.scheduler.change({ action: 'automatic', agentId: f.agent.id, enabled: false }); assert.equal((await f.jobs())[0].status, 'canceled');
  const g = await fixture(t); await g.scheduler.change({ action: 'automatic', agentId: g.agent.id, enabled: true });
  await g.manager.store.update(s => { s.rotations[g.agent.id] = { harness: 'codex', sessionId: 'native-session', failedKey: 'failure', phase: 'continued',
    fromAccountId: g.account.id, targetAccountId: g.account.id, originalOverride: 'inherit', triedRows: [], triedIdentities: [], messageId: randomUUID(),
    lastUserMessageAt: g.agent.lastUserMessageAt, updatedAt: new Date(NOW).toISOString(), message: 'Fixture' }; });
  await g.scheduler.turnEnded(g.agent.id, failure, 'rotation'); assert.equal((await g.jobs()).length, 1);
  assert.equal((await g.jobs())[0].accountId, g.account.id); assert.equal((await g.jobs())[0].message, 'Continue');
});
test('native Claude completed session-limit replies create a reset reservation and resume exactly once', async t => {
  const f = await fixture(t, 'claude'); f.setQuota(quota(100, NOW + 60000));
  await f.scheduler.change({ action: 'automatic', agentId: f.agent.id, enabled: true });
  await f.scheduler.turnEnded(f.agent.id, { outcome: { kind: 'completed' }, timeline: [{ type: 'assistant_message', text: "You've hit your session limit · resets 6:10am (Asia/Seoul)" }] }, 'native-session-limit');
  const [job] = await f.jobs(); assert.equal(job.source, 'automatic'); assert.equal(job.dueAt, new Date(NOW + 60000).toISOString());
  f.advance(59999); await f.tick(); assert.equal(f.sent.length, 0);
  f.setQuota(quota(0)); f.advance(1); await f.tick(); await f.tick(); assert.deepEqual(f.sent, ['Continue']);
});
test('enabling automatic resume after a quota interruption checks the current reply immediately', async t => {
  const f = await fixture(t, 'claude'); f.setQuota(quota(100));
  f.setHistory([{ type: 'user_message', text: 'Finish my work' }, { type: 'assistant_message', text: "You've hit your session limit · resets 6:10am" }]);
  await f.scheduler.change({ action: 'automatic', agentId: f.agent.id, enabled: true });
  assert.equal((await f.jobs())[0].source, 'automatic'); assert.equal(f.sent.length, 0);
});
test('restart recovers a previously unrecognized interrupted session without replaying successful work', async t => {
  const f = await fixture(t, 'claude'); f.setQuota(quota(100));
  await f.manager.store.update(s => { s.schedules.automatic[f.agent.id] = true; });
  f.setHistory([{ type: 'assistant_message', text: "You've hit your session limit · resets 6:10am" }]);
  f.scheduler.dispose(); const restored = new ScheduleManager(f.manager, f.now); t.after(() => restored.dispose());
  await restored.start(f.paseo, true);
  assert.equal((await f.jobs()).length, 1); assert.equal(f.sent.length, 0);
});
test('existing-success, newer-input, stale-error, and manual reservations prevent automatic recovery', async t => {
  for (const mode of ['success', 'new-input', 'stale', 'manual']) {
    const f = await fixture(t, 'claude'); f.setQuota(quota(100));
    const error = { type: 'assistant_message', text: "You've hit your session limit · resets 6:10am" };
    f.setHistory([error, ...(mode === 'success' ? [{ type: 'assistant_message', text: 'Requested work completed.' }] : mode === 'new-input' ? [{ type: 'user_message', text: 'A newer request' }] : [])]);
    if (mode === 'stale') f.agent.attentionTimestamp = new Date(NOW - 86400001).toISOString();
    if (mode === 'manual') await f.reserve('My scheduled instruction');
    await f.scheduler.change({ action: 'automatic', agentId: f.agent.id, enabled: true });
    assert.equal((await f.jobs()).filter(j => j.source === 'automatic').length, 0); assert.equal(f.sent.length, 0);
  }
});
test('a new request during automatic reset lookup cannot inherit the old failure reservation', async t => {
  const f = await fixture(t, 'claude'); await f.scheduler.change({ action: 'automatic', agentId: f.agent.id, enabled: true });
  let entered, release; const reading = new Promise(r => { entered = r; });
  f.setQuota(() => { entered(); return new Promise(r => { release = () => r(quota(100)); }); });
  const ending = f.scheduler.turnEnded(f.agent.id, failure, 'failed-turn'); await reading;
  f.agent.lastUserMessageAt = new Date(NOW + 500).toISOString(); f.agent.activeTurn = { turnId: 'new-turn' }; f.agent.status = 'running';
  release(); await ending; assert.equal((await f.jobs()).length, 0); assert.equal(f.sent.length, 0);
});
test('a quota failure before a manual scheduled-send acknowledgement creates the automatic follow-up', async t => {
  const f = await fixture(t, 'claude'); await f.scheduler.change({ action: 'automatic', agentId: f.agent.id, enabled: true });
  await f.reserve('Resume my work'); f.advance(1000);
  f.setSend(async () => {
    f.agent.lastUserMessageAt = new Date(f.now()).toISOString(); f.setQuota(quota(100, NOW + 60000));
    await f.scheduler.turnEnded(f.agent.id, failure, 'early-failure');
  });
  await f.tick(); assert.equal((await f.jobs()).filter(j => j.source === 'automatic' && j.status === 'waiting').length, 1);
  f.setSend(null); f.setQuota(quota(0)); f.advance(59000); await f.tick(); await f.tick();
  assert.deepEqual(f.sent, ['Resume my work', 'Continue']);
});
test('unsupported host refuses scheduling and state version 2 migrates atomically', async t => {
  const f = await fixture(t); f.scheduler.dispose(); const unsupported = new ScheduleManager(f.manager, f.now); unsupported.connect(f.paseo); t.after(() => unsupported.dispose());
  await assert.rejects(unsupported.change({ action: 'save', agentId: f.agent.id, message: 'Continue', dueAt: new Date(NOW + 1000).toISOString() }), /업데이트/);
  const old = await f.manager.store.read(); old.version = 2; delete old.schedules; await writeFile(join(f.root, 'metadata.json'), JSON.stringify(old));
  await f.manager.store.update(() => {}); assert.equal(JSON.parse(await readFile(join(f.root, 'metadata.json'))).version, 3);
});

test('Claude supports custom messages and wakes immediately when permission waiting ends', async t => {
  const f = await fixture(t, 'claude'); await f.reserve('남은 작업을 계속해줘'); f.advance(1000);
  f.agent.pendingPermissions = [{ id: 'approval' }]; await f.tick(); assert.equal(f.sent.length, 0);
  f.agent.pendingPermissions = []; await f.scheduler.wakeAgent(f.agent.id); await f.tick();
  assert.deepEqual(f.sent, ['남은 작업을 계속해줘']);
});
test('cancel during a slow quota read prevents submission', async t => {
  const f = await fixture(t); await f.reserve(); f.advance(1000);
  let release, entered;
  const reading = new Promise(r => { entered = r; });
  f.setQuota(() => { entered(); return new Promise(r => { release = () => r(quota(0)); }); });
  const running = f.scheduler.kick(); await reading;
  const [job] = await f.jobs(); await f.scheduler.change({ action: 'cancel', id: job.id }); release(); await running;
  assert.equal(f.sent.length, 0); assert.equal((await f.jobs())[0].status, 'canceled');
});
test('service rollover delay is retried and missing automatic reset data is visible', async t => {
  const f = await fixture(t); await f.reserve(); f.advance(1000); f.setQuota(quota(100, f.now())); await f.tick();
  assert.equal((await f.jobs())[0].status, 'waiting'); f.setQuota(quota(0)); f.advance(30000); await f.tick(); assert.equal(f.sent.length, 1);
  const g = await fixture(t); await g.scheduler.change({ action: 'automatic', agentId: g.agent.id, enabled: true });
  g.setQuota(new QuotaError('error', 'private-native-error')); await g.scheduler.turnEnded(g.agent.id, failure, 'missing-reset');
  const [job] = await g.jobs(); assert.equal(job.status, 'waiting'); assert.equal(job.waitingFor, 'quota'); assert.equal(g.cards.get(job.id).status, 'waiting');
  assert.ok(!JSON.stringify(job).includes('private-native-error'));
});
test('automatic failure deduplication survives restarting the scheduler', async t => {
  const f = await fixture(t); f.setQuota(quota(100)); await f.scheduler.change({ action: 'automatic', agentId: f.agent.id, enabled: true });
  await f.scheduler.turnEnded(f.agent.id, failure, 'same-turn'); const [job] = await f.jobs();
  await f.scheduler.change({ action: 'cancel', id: job.id }); f.scheduler.dispose();
  const restored = new ScheduleManager(f.manager, f.now); t.after(() => restored.dispose()); restored.start(f.paseo, true);
  await restored.turnEnded(f.agent.id, failure, 'same-turn'); assert.equal((await f.jobs()).length, 1); assert.equal((await f.jobs())[0].status, 'canceled');
});

test('scheduled reset messages wait while current-account limits are unknown or absent',async t=>{
 for(const status of ['unavailable','empty','error']){
  const f=await fixture(t);await f.reserve();f.advance(1000);
  const q=quota(0);f.setQuota(status==='empty'?{...q,windows:[]}:{...q,status});await f.tick();
  assert.equal(f.sent.length,0);assert.equal((await f.jobs())[0].status,'waiting');
 }
});
test('a rewind branch does not replay an inherited old quota error during automatic recovery',async t=>{
 const f=await fixture(t,'claude');f.setQuota(quota(100));f.setHistory([{type:'assistant_message',text:"You've hit your session limit"}]);
 await f.manager.store.update(s=>{s.usage.finished[f.agent.id]='generation:previous-native-session:turn-1';});
 await f.scheduler.change({action:'automatic',agentId:f.agent.id,enabled:true});assert.equal((await f.jobs()).length,0);
});

test('quota errors show the cause and retry time without claiming reset data is absent', async t => {
 const f=await fixture(t,'claude'); let calls=0;
 f.setQuota(()=>{calls++;throw new QuotaError('error','한도 조회 요청이 많습니다. 잠시 후 다시 시도하세요.',120000);});
 await f.scheduler.list(f.agent.id);await new Promise(setImmediate);
 const result=await f.scheduler.list(f.agent.id,true);
 assert.match(result.error,/요청이 많/);assert.equal(result.resetReason,null);assert.equal(result.defaultAt,null);
 assert.equal(result.retryAt,new Date(NOW+120000).toISOString());assert.equal(calls,1);
 assert.ok(!result.error.includes('인증'));f.advance(120000);f.setQuota(quota(0,NOW+3600000));
 await f.scheduler.list(f.agent.id);await new Promise(setImmediate);const recovered=await f.scheduler.list(f.agent.id);
 assert.equal(recovered.error,null);assert.equal(recovered.defaultAt,new Date(NOW+3600000).toISOString());
});
test('failed refresh retains the exact account last reset and timestamp while blocking transmission',async t=>{
 const f=await fixture(t);await f.scheduler.list(f.agent.id);await new Promise(setImmediate);
 const initial=await f.scheduler.list(f.agent.id);f.advance(300001);f.setQuota(new QuotaError('error','한도 조회 요청이 많습니다.',120000));
 await f.scheduler.list(f.agent.id);await new Promise(setImmediate);const stale=await f.scheduler.list(f.agent.id);
 assert.equal(stale.defaultAt,initial.defaultAt);assert.equal(stale.quotaFetchedAt,initial.quotaFetchedAt);assert.match(stale.resetReason,/마지막으로 조회/);
 await f.reserve();f.advance(1000);await f.tick();assert.equal(f.sent.length,0);
});
test('dashboard and reservation use one quota cache for the same profile and identity',async t=>{
 const f=await fixture(t),calls=[];const home=f.manager.profile(f.account);
 await f.manager.store.update(s=>{s.bindings[f.agent.id].home=home;});
 f.manager.adapters.codex.quota=async h=>{calls.push(h);return quota(20);};
 f.paseo.agents.list=async()=>({entries:[],pageInfo:{hasMore:false,nextCursor:null}});
 await f.manager.snapshot(f.paseo);await f.scheduler.list(f.agent.id);await new Promise(setImmediate);
 const result=await f.scheduler.list(f.agent.id);const snapshot=await f.manager.snapshot(f.paseo);
 assert.equal(calls.filter(h=>h===home).length,1);assert.equal(result.defaultAt,snapshot.accounts[0].metrics.quota.windows[0].resetsAt);
});
test('automatic reset lookup waits through Retry-After and schedules the real reset before sending',async t=>{
 const f=await fixture(t,'claude');let calls=0;
 f.setQuota(()=>{calls++;throw new QuotaError('error','한도 조회 요청이 많습니다.',120000);});
 await f.scheduler.change({action:'automatic',agentId:f.agent.id,enabled:true});await f.scheduler.turnEnded(f.agent.id,failure,'limited');
 let [job]=await f.jobs();assert.equal(job.status,'waiting');assert.equal(job.waitingFor,'quota');assert.equal(job.nextAttemptAt,new Date(NOW+120000).toISOString());
 for(let i=0;i<4;i++){f.advance(20000);await f.scheduler.wakeAgent(f.agent.id);await f.tick();}
 assert.equal(calls,1);assert.equal(f.sent.length,0);
 f.setQuota(quota(100,NOW+180000));f.advance(40000);await f.tick();[job]=await f.jobs();
 assert.equal(job.dueAt,new Date(NOW+180000).toISOString());assert.equal(job.waitingFor,null);assert.equal(f.sent.length,0);
 f.setQuota(quota(0,NOW+3600000));f.advance(60000);await f.tick();await f.tick();assert.deepEqual(f.sent,['Continue']);
});
