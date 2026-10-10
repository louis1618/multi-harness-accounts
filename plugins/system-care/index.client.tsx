import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CarePanel } from "./client/panel.js";
export default function contribute(c: PluginClientContext) {
  c.addSurface("care", CarePanel);
  c.addSidebarItem({
    id: "care",
    title: "시스템 관리",
    icon: "Activity",
    surface: "care",
  });
  c.addCommandCenterItem({
    id: "system-care",
    title: "시스템 관리",
    icon: "Activity",
    context: "global",
    keywords: ["용량", "리소스", "Docker", "정리"],
    onSelect({ openSurface }) {
      openSurface("care");
    },
  });
  return () => {};
}
