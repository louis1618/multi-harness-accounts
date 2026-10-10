import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Finder } from "./client/finder";
export default function contribute(client: PluginClientContext) {
 client.addSurface("finder", Finder);
 client.addSidebarItem({ id: "finder", title: "파일", icon: "FolderOpen", surface: "finder" });
 client.addCommandCenterItem({ id: "open-finder", title: "홈 폴더 탐색", icon: "FolderOpen", context: "global", keywords: ["Finder", "파일", "폴더"], onSelect({ openSurface }) { openSurface("finder"); } });
 return () => {};
}
