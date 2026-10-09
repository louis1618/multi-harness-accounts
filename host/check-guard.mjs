// Exercises a prepared runtime with local state only; never connects to a daemon or model.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { installGuard } from './install-guard.mjs';

assert.ok(process.argv[2], 'Usage: node host/check-guard.mjs /absolute/path/to/prepared-runtime');
const root = resolve(process.argv[2]), modules = join(root, 'node_modules/@getpaseo');
const file = join(modules, 'server/dist/server/server/agent/agent-prompt.js');
const source = await readFile(file, 'utf8');
const start = source.indexOf('async function startOrReplaceRun('), end = source.indexOf('async function drainAgentRunIterator', start);
assert.ok(start >= 0 && end > start && source.slice(start, end).includes('SCHEDULE_GUARD_BUSY'));
const { startOrReplaceRun } = await import('data:text/javascript,' + encodeURIComponent(source.slice(start, end) + '\nexport { startOrReplaceRun };'));
const at = '2026-10-09T00:00:00.000Z';
const agent = { lifecycle: 'idle', provider: 'claude', persistence: { sessionId: 'fixture' }, lastUserMessageAt: new Date(at),
  activeForegroundTurnId: null, pendingPermissions: new Map(), inFlightPermissionResponses: new Set() };
let busy = false, sends = 0;
const controller = { getAgent: () => agent, hasInFlightRun: () => busy,
  streamAgent: () => { busy = true; sends++; return (async function* () {})(); },
  replaceAgentRun: () => assert.fail('Must not replace work') };
const guard = { lastUserMessageAt: at, provider: 'claude', sessionId: 'fixture' };
const run = sendGuard => startOrReplaceRun(controller, 'fixture', 'Continue', { replaceRunning: true, sendGuard });
agent.pendingPermissions.set('approval', {});
await assert.rejects(run(guard), /SCHEDULE_GUARD_BUSY/); assert.equal(agent.pendingPermissions.size, 1);
agent.pendingPermissions.clear(); agent.inFlightPermissionResponses.add('approval');
await assert.rejects(run(guard), /SCHEDULE_GUARD_BUSY/); agent.inFlightPermissionResponses.clear();
agent.lifecycle = 'running'; await assert.rejects(run(guard), /SCHEDULE_GUARD_BUSY/); agent.lifecycle = 'idle';
agent.lifecycle = 'closed'; await assert.rejects(run(guard), /SCHEDULE_GUARD_ARCHIVED/); agent.lifecycle = 'idle';
for (const changed of [{ ...guard, lastUserMessageAt: null }, { ...guard, provider: 'codex' }, { ...guard, sessionId: 'changed' }])
  await assert.rejects(run(changed), /SCHEDULE_GUARD_CHANGED/);
assert.equal(sends, 0);
await run(guard); await assert.rejects(run(guard), /SCHEDULE_GUARD_BUSY/); assert.equal(sends, 1);
const { SendAgentMessageRequestSchema } = await import(pathToFileURL(join(modules, 'protocol/dist/messages.js')).href);
assert.deepEqual(SendAgentMessageRequestSchema.parse({ type: 'send_agent_message_request', requestId: 'fixture', agentId: 'fixture', text: 'Continue', sendGuard: guard }).sendGuard, guard);
const { MessageReceipts } = await import(pathToFileURL(join(modules, 'server/dist/server/server/message-receipts/index.js')).href);
const directory = await mkdtemp(join(tmpdir(), 'paseo-guard-check-'));
try {
  const receipts = new MessageReceipts(directory);
  const input = { agentId: 'fixture', messageId: 'fixture', request: { prompt: 'Continue', sendGuard: guard } };
  for (const code of ['BUSY', 'CHANGED', 'ARCHIVED']) {
    await assert.rejects(receipts.send({ ...input, send: async () => { throw Error('SCHEDULE_GUARD_' + code); } }), /SCHEDULE_GUARD_/);
    assert.deepEqual(await readdir(directory), []);
  }
  let delivered = 0;
  await Promise.all([1, 2, 3].map(() => receipts.send({ ...input, send: async () => { delivered++; } })));
  assert.equal(delivered, 1);
  await assert.rejects(receipts.send({ ...input, request: { prompt: 'changed' }, send: async () => { delivered++; } }), /agent_request_key_conflict/);
  const uncertain = { ...input, messageId: 'uncertain', send: async () => { throw Error('disconnected'); } };
  await assert.rejects(receipts.send(uncertain), /disconnected/);
  await assert.rejects(receipts.send(uncertain), /agent_request_outcome_unknown/);
} finally { await rm(directory, { recursive: true, force: true }); }
assert.deepEqual(await installGuard(root), []);
console.log(JSON.stringify({ guardedMessages: true, approvalsPreserved: true, receiptDedupe: true, protocolPreservesGuard: true, installerIdempotent: true, productionPrompts: 0 }));
