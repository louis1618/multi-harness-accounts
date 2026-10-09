import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installRewind } from '../host/install-rewind.mjs';

const original = `class Session {
    start() {
            this.startQueryPump();
            this.input.push(sdkMessage);
            setTimeout(() => {
                if (this.activeForegroundTurnId === turnId) {
                    this.emitSubmittedUserMessage(sdkMessage, turnId, options?.clientMessageId);
                }
            }, 0);
    }
    ensureQuery() {
        // Preserve claudeSessionId across query recreation so buildOptions() passes
        this.persistence = null;
    }
    startQueryPump() {
        if (this.closed || this.queryPumpPromise) {
            return;
        }
        const pump = this.runQueryPump().catch((error) => {});
    }
    async runQueryPump() {
        let activeQuery;
        activeQuery = await this.ensureQuery();
        let consecutiveInterruptAbortRecoveries = 0;
    }
}
// Existing guarded-message and other host changes must survive.
const guardedAgentMessages = 1;
`;
async function fixture(t, version = '0.10.3', source = original) {
  const root = await mkdtemp(join(tmpdir(), 'paseo-rewind-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = join(root, 'node_modules/@getpaseo/server');
  const file = join(server, 'dist/server/server/agent/providers/claude/agent.js');
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(join(server, 'package.json'), JSON.stringify({ version }));
  await writeFile(file, source);
  return { root, file };
}
for (const version of ['0.10.3', '0.11.1']) test(`host ${version} preparation preserves Claude identity and is idempotent`, async t => {
  const { root, file } = await fixture(t, version);
  assert.deepEqual(await installRewind(root), [file]);
  const patched = await readFile(file, 'utf8');
  assert.match(patched, /this\.input\.push\(sdkMessage\);\s*\/\/[^\n]+\s*this\.emitSubmittedUserMessage\(sdkMessage, turnId, options\?\.clientMessageId\);\s*this\.startQueryPump\(\);/);
  assert.match(patched, /this\.runQueryPump\(this\.query\)/);
  assert.match(patched, /async runQueryPump\(activeQuery\)/);
  assert.match(patched, /current settings\.\n        this\.queryRestartNeeded = false;/);
  assert.ok(patched.endsWith('const guardedAgentMessages = 1;\n'));
  assert.equal(await readFile(file + '.before-rewind-identity', 'utf8'), original);
  assert.deepEqual(await installRewind(root), []);
  assert.equal(await readFile(file, 'utf8'), patched);
});
test('unexpected version, partial fix and changed runtime fail before writing', async t => {
  const version = await fixture(t, '0.11.0');
  await assert.rejects(installRewind(version.root), /0.10.3 or 0.11.1 only/);
  assert.equal(await readFile(version.file, 'utf8'), original);
  for (const source of [original.replace('this.startQueryPump();', 'changed();'), original + '// Paseo rewind identity: publish before the query can finish.']) {
    const { root, file } = await fixture(t, '0.10.3', source);
    await assert.rejects(installRewind(root), /Unexpected|Partial/);
    assert.equal(await readFile(file, 'utf8'), source);
    await assert.rejects(readFile(file + '.before-rewind-identity'), { code: 'ENOENT' });
  }
});
