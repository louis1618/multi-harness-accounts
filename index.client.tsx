import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AccountsSurface, AgentAccountsPanel } from "./client/accounts.js";

export default function contribute(client: PluginClientContext) {
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
  return () => {};
}
