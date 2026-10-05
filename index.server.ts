import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ExtensionManager } from "./server/extensions.js";
import { inventoryExtensions, commonExtensions, previewExtensions, applyExtensions, mutateExtension, extensionDetails, extensionJobs } from "./shared/extensions.js";
import { AccountManager } from "./server/manager.js";
import { ScheduleManager } from "./server/schedules.js";
import { ProfileHistoryGuard } from "./server/profile-history.js";
import { listSchedules, changeSchedule } from "./shared/schedules.js";
import { listAccounts, changeAccount, listSessions, importAccountSession, prepareReset, consumeReset } from "./shared/accounts.js";

export default function contribute(server: PluginServerContext) {
  const manager = new AccountManager();
  const extensions = new ExtensionManager(manager);
  const schedules = new ScheduleManager(manager);
  const history = new ProfileHistoryGuard(manager);
  const startup = server as PluginServerContext & { paseo?: Parameters<ScheduleManager["start"]>[0]; capabilities?: { guardedAgentMessages?: number } };
  if (startup.paseo) {
    schedules.start(startup.paseo, startup.capabilities?.guardedAgentMessages === 1);
    void history.start(startup.paseo).catch(() => {});
  }
  const safe = async <T,>(operation: Promise<T>) => {
    try { return await operation; } catch (error) { throw new Error(manager.publicError(error)); }
  };
  server.handle(listAccounts, (_, { paseo }) => safe(manager.snapshot(paseo)));
  server.handle(changeAccount, (input, { paseo }) => safe((async () => {
    extensions.setPaseo(paseo);
    const before = input.action === "add" ? (await manager.store.read()).accounts.map(a => a.id) : [];
    if (["select", "inherit", "remove", "logout-system", "relogin", "relogin-system"].includes(input.action)) {
      const current = await manager.store.read();
      for (const job of Object.values(current.schedules.jobs)) {
        const affected = input.action === "select" ? (input.agentId ? job.agentId === input.agentId : job.harness === input.harness && !Object.hasOwn(current.overrides, job.agentId))
          : input.action === "inherit" ? job.agentId === input.agentId
          : input.action === "remove" || input.action === "relogin" ? job.accountId === input.id
          : (input.action === "logout-system" || input.action === "relogin-system") && job.harness === input.harness && job.accountId === null;
        if (affected) await schedules.cancelAgent(job.agentId, "계정 설정이 변경되어 예약을 취소했습니다.");
      }
    }
    const result = await manager.exclusive(() => extensions.withAccountChange(input, () => manager.change(input, paseo)));
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
  server.handle(listSchedules, (input, { paseo }) => { schedules.connect(paseo); return safe(schedules.list(input.agentId)); });
  server.handle(changeSchedule, (input, { paseo }) => { schedules.connect(paseo); return safe(schedules.change(input)); });
  server.before("agent.session_open", ({ request }, { paseo }) => safe((async () => {
    extensions.setPaseo(paseo); const result = await manager.openSession(request, paseo);
    if (request.provider === "codex" || request.provider === "claude") {
      const accountId = (await manager.store.read()).bindings[request.agentId]?.accountId ?? null;
      void extensions.automatic(request.provider, accountId, "switch").catch(() => {});
    } return result;
  })()));
  server.on("agent.turn_started", ({ agent, turnId }, { paseo }) => safe((async () => { await manager.beginTurn(agent.id, turnId, paseo); await schedules.turnStarted(agent.id); })()));
  server.on("agent.turn_ended", ({ agent, turnId, outcome, timeline }, { paseo }) => safe((async () => {
    await manager.endTurn(agent.id, turnId, paseo, { outcome, timeline }, () => schedules.turnEnded(agent.id, { outcome, timeline }, turnId));
  })()));
  server.on("agent.archived", ({ agent }, { paseo }) => { schedules.connect(paseo); return safe(schedules.cancelAgent(agent.id, "세션이 보관되어 예약을 취소했습니다.")); });
  server.on("agent.permission_resolved", ({ agent }) => safe(schedules.wakeAgent(agent.id)));
  server.on("agent.created", ({ agent }, { paseo }) => safe(manager.prepareCreatedAgent(agent.id, paseo)));
  return () => { history.dispose(); schedules.dispose(); extensions.dispose(); manager.dispose(); };
}
