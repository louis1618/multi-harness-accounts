// Only modifies a staging runtime. Activation requires restarting the host separately.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function installRewind(runtime) {
  const modules = join(resolve(runtime), 'node_modules', '@getpaseo');
  const file = join(modules, 'server/dist/server/server/agent/providers/claude/agent.js');
  const original = await readFile(file, 'utf8');
  const marker = '// Paseo rewind identity: publish before the query can finish.';
  if (original.includes(marker)) {
    if (!original.includes('this.runQueryPump(this.query)') || !original.includes('async runQueryPump(activeQuery)') ||
      !original.includes('// A fresh query already uses the current settings.')) throw Error('Partial Claude rewind fix.');
    return [];
  }
  let source = original;
  const replace = (before, after) => {
    if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before))
      throw Error('Unexpected Claude runtime shape; no files changed.');
    source = source.replace(before, after);
  };
  replace(`            this.startQueryPump();
            this.input.push(sdkMessage);
            setTimeout(() => {
                if (this.activeForegroundTurnId === turnId) {
                    this.emitSubmittedUserMessage(sdkMessage, turnId, options?.clientMessageId);
                }
            }, 0);`, `            this.input.push(sdkMessage);
            ${marker}
            this.emitSubmittedUserMessage(sdkMessage, turnId, options?.clientMessageId);
            this.startQueryPump();`);
  replace('        // Preserve claudeSessionId across query recreation so buildOptions() passes',
    '        // A fresh query already uses the current settings.\n        this.queryRestartNeeded = false;\n        // Preserve claudeSessionId across query recreation so buildOptions() passes');
  replace('        if (this.closed || this.queryPumpPromise) {', '        if (this.closed || this.queryPumpPromise || !this.query) {');
  replace('        const pump = this.runQueryPump().catch((error) => {', '        const pump = this.runQueryPump(this.query).catch((error) => {');
  const start = source.indexOf('    async runQueryPump() {'), end = source.indexOf('        let consecutiveInterruptAbortRecoveries = 0;', start);
  if (start < 0 || end < start || !source.slice(start, end).includes('activeQuery = await this.ensureQuery();'))
    throw Error('Unexpected Claude query pump; no files changed.');
  source = source.slice(0, start) + '    async runQueryPump(activeQuery) {\n' + source.slice(end);
  await copyFile(file, file + '.before-rewind-identity');
  await writeFile(file, source);
  return [file];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw Error('Usage: node host/install-rewind.mjs /absolute/path/to/staging-runtime');
  console.log(JSON.stringify({ patched: await installRewind(process.argv[2]) }));
}
