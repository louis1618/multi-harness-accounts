import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AccountManager } from "./server/manager.js";
import { listAccounts, changeAccount, listSessions, importAccountSession, prepareReset, consumeReset } from "./shared/accounts.js";

export default function contribute(server: PluginServerContext) {
  const manager = new AccountManager();
  const safe = async <T,>(operation: Promise<T>) => {
    try { return await operation; } catch (error) { throw new Error(manager.publicError(error)); }
  };
  server.handle(listAccounts, (_, { paseo }) => safe(manager.snapshot(paseo)));
  server.handle(changeAccount, (input, { paseo }) => safe(manager.change(input, paseo)));
  server.handle(listSessions, (input, { paseo }) => safe(manager.sessions(paseo, input.refresh)));
  server.handle(importAccountSession, (input, { paseo }) => safe(manager.importSession(input.id, paseo)));
  server.handle(prepareReset, input => safe(manager.prepareReset(input.accountId, input.harness)));
  server.handle(consumeReset, input => safe(manager.consumeReset(input.attemptId, input.creditId, input.confirmed)));
  server.before("agent.session_open", ({ request }, { paseo }) => safe(manager.openSession(request, paseo)));
  server.on("agent.turn_started", ({ agent, turnId }, { paseo }) => safe(manager.beginTurn(agent.id, turnId, paseo)));
  server.on("agent.turn_ended", ({ agent, turnId }, { paseo }) => safe(manager.endTurn(agent.id, turnId, paseo)));
  server.on("agent.created", ({ agent }, { paseo }) => safe(manager.prepareCreatedAgent(agent.id, paseo)));
  return () => manager.dispose();
}
