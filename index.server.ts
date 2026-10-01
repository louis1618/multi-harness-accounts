import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ExtensionManager } from "./server/extensions.js";
import { inventoryExtensions, commonExtensions, previewExtensions, applyExtensions, mutateExtension, extensionDetails, extensionJobs } from "./shared/extensions.js";
import { AccountManager } from "./server/manager.js";
import { listAccounts, changeAccount, listSessions, importAccountSession, prepareReset, consumeReset } from "./shared/accounts.js";

export default function contribute(server: PluginServerContext) {
  const manager = new AccountManager();
  const extensions = new ExtensionManager(manager);
  const safe = async <T,>(operation: Promise<T>) => {
    try { return await operation; } catch (error) { throw new Error(manager.publicError(error)); }
  };
  server.handle(listAccounts, (_, { paseo }) => safe(manager.snapshot(paseo)));
  server.handle(changeAccount, (input, { paseo }) => safe((async () => {
    extensions.setPaseo(paseo);
    const before = input.action === "add" ? (await manager.store.read()).accounts.map(a => a.id) : [];
    const result = await extensions.withAccountChange(input, () => manager.change(input, paseo));
    if (input.action === "add") for (const a of (await manager.store.read()).accounts.filter(a => !before.includes(a.id))) await extensions.automatic(a.harness, a.id, "new");
    return result;
  })()));
  server.handle(inventoryExtensions, (input, { paseo }) => { extensions.setPaseo(paseo); return safe(extensions.inventory(input)); });
  server.handle(commonExtensions, (input, { paseo }) => { extensions.setPaseo(paseo); return safe(extensions.common(input.target, input.keys, input.remove, input.autoNew, input.autoSwitch)); });
  server.handle(previewExtensions, (input, { paseo }) => { extensions.setPaseo(paseo); return safe(extensions.preview(input.targets, input.keys)); });
  server.handle(applyExtensions, (input, { paseo }) => { extensions.setPaseo(paseo); return safe(extensions.apply(input.id, input.replace)); });
  server.handle(mutateExtension, (input, { paseo }) => { extensions.setPaseo(paseo); return safe(extensions.mutate(input.target, input.kind, input.name, input.action, input.value)); });
  server.handle(extensionDetails, (input, { paseo }) => { extensions.setPaseo(paseo); return safe(extensions.details(input.target, input.key)); });
  server.handle(extensionJobs, (input, { paseo }) => { extensions.setPaseo(paseo); return safe(extensions.jobs(input)); });
  server.handle(listSessions, (input, { paseo }) => safe(manager.sessions(paseo, input.refresh)));
  server.handle(importAccountSession, (input, { paseo }) => safe(manager.importSession(input.id, paseo)));
  server.handle(prepareReset, input => safe(manager.prepareReset(input.accountId, input.harness)));
  server.handle(consumeReset, input => safe(manager.consumeReset(input.attemptId, input.creditId, input.confirmed)));
  server.before("agent.session_open", ({ request }, { paseo }) => safe((async () => {
    extensions.setPaseo(paseo); const result = await manager.openSession(request, paseo);
    if (request.provider === "codex" || request.provider === "claude") {
      const accountId = (await manager.store.read()).bindings[request.agentId]?.accountId ?? null;
      void extensions.automatic(request.provider, accountId, "switch").catch(() => {});
    } return result;
  })()));
  server.on("agent.turn_started", ({ agent, turnId }, { paseo }) => safe(manager.beginTurn(agent.id, turnId, paseo)));
  server.on("agent.turn_ended", ({ agent, turnId, outcome, timeline }, { paseo }) => safe(manager.endTurn(agent.id, turnId, paseo, { outcome, timeline })));
  server.on("agent.created", ({ agent }, { paseo }) => safe(manager.prepareCreatedAgent(agent.id, paseo)));
  return () => { extensions.dispose(); manager.dispose(); };
}
