import type { PluginServerContext } from "@getpaseo/plugin/server";
import { HomeFiles } from "./server/files";
import { listRpc, actionRpc, previewRpc, linkRpc, urlSettingRpc } from "./shared/files";
export default function contribute(server: PluginServerContext) {
 const files = new HomeFiles();
 server.handle(listRpc, input => files.list(input));
 server.handle(actionRpc, input => files.change(input));
 server.handle(previewRpc, input => files.preview(input));
 server.handle(linkRpc, input => files.link(input));
 server.handle(urlSettingRpc, input => files.urlSetting(input));
 return () => { void files.dispose(); };
}
