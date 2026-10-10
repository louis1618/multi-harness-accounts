// Applies the reviewed host extension to a STAGING runtime, preserving other patches.
// Never restarts a daemon or writes to a mounted/running AppImage.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installRewind } from './install-rewind.mjs';

export async function installGuard(runtime) {
  const modules = join(resolve(runtime), 'node_modules', '@getpaseo');
  const pluginFile = join(modules, 'server/dist/server/server/plugins/plugin-process.js');
  const pluginSource = await readFile(pluginFile, 'utf8');
  const entries = [...pluginSource.matchAll(/const contributedCleanup = (setup|contribute)\(\{/g)];
  if (entries.length !== 1) throw Error('Unexpected plugin lifecycle shape; no files changed.');
  const changes = new Map();
  const replace = async (relative, before, after) => {
    const file = join(modules, relative), source = changes.get(file) ?? await readFile(file, 'utf8');
    if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw Error(`Unexpected runtime shape: ${relative}`);
    changes.set(file, source.replace(before, after));
  };
  if (pluginSource.includes('guardedAgentMessages: 1')) {
    for (const [file, token] of [['protocol/dist/messages.js','sendGuard: z.object'], ['client/dist/daemon-client.js','options?.sendGuard'],
      ['server/dist/server/server/agent/agent-prompt.js','SCHEDULE_GUARD_CHANGED'], ['server/dist/server/server/session.js','sendGuard: msg.sendGuard'],
      ['server/dist/server/server/message-receipts/index.js','SCHEDULE_GUARD_(BUSY|CHANGED|ARCHIVED)']])
      if (!(await readFile(join(modules,file),'utf8')).includes(token)) throw Error('Partial host extension. Restore the .before-scheduled-messages files first.');
    return await installRewind(runtime);
  }
  await replace('protocol/dist/messages.js', 'export const SendAgentMessageRequestSchema = z.object({\n', 'export const SendAgentMessageRequestSchema = z.object({\n    sendGuard: z.object({ lastUserMessageAt: z.string().nullable(), provider: z.string().optional(), sessionId: z.string().optional() }).optional(),\n');
  await replace('client/dist/daemon-client.js', '...(options?.activeTurnBehavior ? { activeTurnBehavior: options.activeTurnBehavior } : {}),', '...(options?.activeTurnBehavior ? { activeTurnBehavior: options.activeTurnBehavior } : {}),\n            ...(options?.sendGuard ? { sendGuard: options.sendGuard } : {}),');
  const entry = entries[0][1];
  await replace('server/dist/server/server/plugins/plugin-process.js', `const contributedCleanup = ${entry}({`, `const contributedCleanup = ${entry}({\n        paseo,\n        capabilities: { guardedAgentMessages: 1 },`);
  const guard = `if (options?.sendGuard) {
        const agent = agentManager.getAgent(agentId);
        if (!agent || agent.lifecycle === "closed") throw new Error("SCHEDULE_GUARD_ARCHIVED");
        if (!["idle", "error"].includes(agent.lifecycle) || agent.activeForegroundTurnId || agentManager.hasInFlightRun(agentId) || agent.pendingPermissions.size || agent.inFlightPermissionResponses.size)
            throw new Error("SCHEDULE_GUARD_BUSY");
        if ((agent.lastUserMessageAt?.toISOString() ?? null) !== options.sendGuard.lastUserMessageAt)
            throw new Error("SCHEDULE_GUARD_CHANGED");
        if (options.sendGuard.provider && agent.provider !== options.sendGuard.provider || options.sendGuard.sessionId && agent.persistence?.sessionId !== options.sendGuard.sessionId)
            throw new Error("SCHEDULE_GUARD_CHANGED");
        return { iterator: agentManager.streamAgent(agentId, prompt, options.runOptions), replaced: false };
    }
    `;
  await replace('server/dist/server/server/agent/agent-prompt.js', 'async function startOrReplaceRun(agentManager, agentId, prompt, options) {\n    ', 'async function startOrReplaceRun(agentManager, agentId, prompt, options) {\n    '+guard);
  await replace('server/dist/server/server/agent/agent-prompt.js', 'if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {', 'if (!options?.sendGuard && agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {');
  await replace('server/dist/server/server/agent/agent-prompt.js', 'const steered = await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);', 'const steered = options?.sendGuard ? null : await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);');
  await replace('server/dist/server/server/agent/agent-prompt.js', 'if (record?.archivedAt) {', 'if (record?.archivedAt) {\n        if (params.sendGuard) throw new Error("SCHEDULE_GUARD_ARCHIVED");');
  await replace('server/dist/server/server/agent/agent-prompt.js', 'return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {', 'return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {\n        sendGuard: params.sendGuard,');
  await replace('server/dist/server/server/session.js', 'activeTurnBehavior: msg.activeTurnBehavior ?? "interrupt",\n                    clearPendingPermissions: true,', 'activeTurnBehavior: msg.activeTurnBehavior ?? "interrupt",\n                    sendGuard: msg.sendGuard,\n                    clearPendingPermissions: !msg.sendGuard,');
  await replace('server/dist/server/server/session.js', 'request: { prompt, activeTurnBehavior: msg.activeTurnBehavior ?? "interrupt" },', 'request: { prompt, activeTurnBehavior: msg.activeTurnBehavior ?? "interrupt", ...(msg.sendGuard ? { sendGuard: msg.sendGuard } : {}) },');
  await replace('server/dist/server/server/session.js', 'textPrefix: msg.text.slice(0, 80),', 'textPrefix: msg.sendGuard ? undefined : msg.text.slice(0, 80),');
  await replace('server/dist/server/server/session.js', 'this.handleAgentRunError(resolved.agentId, error, "Failed to send agent message");', 'if (!(error instanceof Error && error.message.startsWith("SCHEDULE_GUARD_")))\n                this.handleAgentRunError(resolved.agentId, error, "Failed to send agent message");');
  await replace('server/dist/server/server/message-receipts/index.js', 'import { readFile } from "node:fs/promises";', 'import { readFile, unlink } from "node:fs/promises";');
  await replace('server/dist/server/server/message-receipts/index.js', 'await input.send();', `try { await input.send(); } catch (error) {
            if (error instanceof Error && /^SCHEDULE_GUARD_(BUSY|CHANGED|ARCHIVED)$/.test(error.message)) await unlink(file);
            throw error;
        }`);
  // Validate every target before changing any file; retain originals for rollback.
  for (const [file, contents] of changes) {
    await copyFile(file, file+'.before-scheduled-messages');
    await writeFile(file, contents);
  }
  return [...changes.keys(), ...await installRewind(runtime)];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw Error('Usage: node host/install-guard.mjs /absolute/path/to/staging-runtime');
  console.log(JSON.stringify({ patched: await installGuard(process.argv[2]) }));
}
