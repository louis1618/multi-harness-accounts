import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CareManager } from "./server/manager.js";
import { CareError } from "./server/util.js";
import {
  snapshotRpc,
  scanRpc,
  previewRpc,
  executeRpc,
  jobsRpc,
  settingsRpc,
  logsRpc,
  helperRpc,
  autoCleanRpc,
} from "./shared/care.js";
export default function contribute(server: PluginServerContext) {
  const m = new CareManager();
  const safe = async <T>(p: Promise<T>) => {
    try {
      return await p;
    } catch (e) {
      throw new Error(
        e instanceof CareError
          ? e.message
          : "작업을 완료하지 못했습니다. 연결 상태와 권한을 확인하세요.",
      );
    }
  };
  server.handle(snapshotRpc, (i) => safe(m.snapshot(i.docker)));
  server.handle(scanRpc, (i) => safe(m.scan(i.cancel)));
  server.handle(previewRpc, (i) => safe(m.preview(i.requests)));
  server.handle(autoCleanRpc, () => safe(m.autoPreview()));
  server.handle(executeRpc, (i) => safe(m.execute(i.id)));
  server.handle(jobsRpc, (i) => safe(m.jobs(i.cancel)));
  server.handle(settingsRpc, (i) => safe(m.configure(i.settings)));
  server.handle(logsRpc, (i) => safe(m.logs(i.id, i.tail)));
  server.handle(helperRpc, () => safe(m.setupHelper()));
  return () => m.dispose();
}
