import type { PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { AccountsSurface, AgentAccountsPanel } from "./client/accounts.js";
import { scheduleUI } from "./client/schedules.js";
import { ScheduleTimelineSchema } from "./shared/schedules.js";

export default function contribute(client: PluginClientContext) {
  const schedules = scheduleUI(client);
  client.addSurface("scheduled-messages", schedules.Surface);
  client.addSidebarItem({ id: "scheduled-messages", title: "예약 메시지", icon: "CalendarClock", surface: "scheduled-messages" });
  client.addTimelineRenderer({ kind: "scheduled-message", version: 1, schema: ScheduleTimelineSchema, Component: schedules.Timeline });
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  let disposed = false;
  let release: (() => Promise<void>) | undefined;
  type Agent = Awaited<ReturnType<typeof client.paseo.agents.list>>["entries"][number]["agent"];
  const update = (agent: Agent) => {
    if (disposed) return;
    const existing = pills.get(agent.id);
    if (agent.archivedAt || !agent.workspaceId || !["codex", "claude"].includes(agent.provider)) {
      existing?.registration.remove(); pills.delete(agent.id); return;
    }
    if (existing?.workspaceId === agent.workspaceId) return;
    existing?.registration.remove();
    const registration = client.addComposerPill({ id: `schedule-${agent.id}`, agentId: agent.id, workspaceId: agent.workspaceId,
      button: { title: "메시지 예약", label: "예약", icon: "CalendarClock", behavior: { kind: "popover", Content: schedules.Composer } } });
    pills.set(agent.id, { workspaceId: agent.workspaceId, registration });
  };
  const stop = client.paseo.agents.subscribe(event => {
    if (event.kind === "upsert") update(event.agent);
    else { pills.get(event.agentId)?.registration.remove(); pills.delete(event.agentId); }
  });
  void (async () => {
    const first = await client.paseo.agents.list({ subscribe: {}, page: { limit: 100 } });
    release = () => first.subscription.release();
    if (disposed) { await release(); return; }
    first.entries.forEach(e => update(e.agent));
    first.subscription.subscribe({ snapshot: page => page.entries.forEach(e => update(e.agent)), update: () => {} });
    let cursor = first.pageInfo.hasMore ? first.pageInfo.nextCursor : null;
    while (cursor && !disposed) {
      const page = await client.paseo.agents.list({ page: { limit: 100, cursor } });
      page.entries.forEach(e => update(e.agent));
      cursor = page.pageInfo.hasMore && page.pageInfo.nextCursor !== cursor ? page.pageInfo.nextCursor : null;
    }
  })().catch(() => {});
  client.addSurface("accounts", AccountsSurface);
  client.addSidebarItem({
    id: "accounts",
    title: "계정",
    icon: "Users",
    surface: "accounts",
  });
  client.addWorkspacePanel({ id: "accounts", title: "계정", icon: "Users", context: "agent",
    locations: ["workspace", "explorer"], Component: AgentAccountsPanel });
  client.addCommandCenterItem({ id: "agent-accounts", title: "에이전트 계정 선택", icon: "Users",
    context: "agent", onSelect({ openPanel }) { openPanel("accounts"); } });
  return () => { disposed = true; stop(); void release?.(); for (const pill of pills.values()) pill.registration.remove(); pills.clear(); };
}
