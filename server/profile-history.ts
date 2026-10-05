import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, link, lstat, open, readFile, readdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AccountManager } from "./manager.js";
import { AccountError, atomicWrite, privateDirectory } from "./store.js";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type PaseoApi = PluginHandlerContext["paseo"];
async function safeDirectory(path: string) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new AccountError("대화 기록 경로가 안전하지 않아 자동 복구를 보류했습니다.");
}
async function transcript(home: string, id: string) {
  await safeDirectory(home);
  const root = join(home, "projects");
  try { await safeDirectory(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const found: string[] = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
    const file = join(root, dir.name, `${id}.jsonl`);
    try { const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink()) throw new AccountError("대화 기록 링크를 자동 복구하지 않습니다."); found.push(file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  if (found.length > 1) throw new AccountError("동일한 대화 기록이 여러 위치에 있어 자동 복구를 보류했습니다.");
  return found[0] ?? null;
}
async function scan(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const before = await handle.stat(), hashes: string[] = [], ids: string[] = [], origins: (string | null)[] = [];
  let fork: { sessionId: string; messageUuid: string } | null = null;
  const stream = handle.createReadStream({ autoClose: false }), digest = createHash("sha256");
  stream.on("data", chunk => { digest.update(chunk); });
  const input = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { throw new AccountError("대화 기록의 JSON을 읽지 못해 자동 복구를 보류했습니다."); }
      if (!["user", "assistant"].includes(row.type)) continue;
      if (!row.message || typeof row.message !== "object") throw new AccountError("대화 메시지 형식이 올바르지 않아 자동 복구를 보류했습니다.");
      if (!hashes.length && row.forkedFrom) fork = row.forkedFrom;
      origins.push(row.forkedFrom?.sessionId === fork?.sessionId ? row.forkedFrom?.messageUuid ?? null : null);
      hashes.push(createHash("sha256").update(JSON.stringify([row.type, row.message])).digest("hex"));
      ids.push(row.uuid ?? "");
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new AccountError("대화 기록이 변경 중입니다. 작업 종료 후 다시 확인하세요.");
    return { hashes, ids, origins, fork, fileHash: digest.digest("hex") };
  } finally { input.close(); stream.destroy(); await handle.close(); }
}

/** SDK fork UUIDs change; verify the selected profile's original messages and exact fork boundary. */
export async function repairClaudeFork(home: string, systemHome: string, id: string, auditRoot: string) {
  if (!uuid.test(id)) throw new AccountError("Claude 대화 ID가 올바르지 않습니다.");
  const existing = await transcript(home, id);
  if (existing) { const data = await scan(existing); return { status: "present" as const, messages: data.hashes.length }; }
  if (resolve(home) === resolve(systemHome)) return { status: "missing" as const, messages: 0 };
  const source = await transcript(systemHome, id);
  if (!source) return { status: "missing" as const, messages: 0 }; // A deliberately fresh conversation has no fork transcript yet.
  const branch = await scan(source);
  if (!branch.fork || !uuid.test(branch.fork.sessionId) || !uuid.test(branch.fork.messageUuid))
    throw new AccountError("원본 계정의 되감기 관계를 확인하지 못해 자동 복구를 보류했습니다.");
  const parent = await transcript(home, branch.fork.sessionId);
  if (!parent) throw new AccountError("현재 계정에 되감기 원본 기록이 없어 자동 복구를 보류했습니다.");
  const original = await scan(parent), length = branch.hashes.length;
  if (!length || length > original.hashes.length || branch.ids.some(id => !uuid.test(id)) || branch.hashes.some((h, i) => h !== original.hashes[i]) ||
    branch.origins.some((id, i) => !id || id !== original.ids[i]))
    throw new AccountError("현재 계정의 원본과 되감기 기록이 일치하지 않아 자동 복구를 보류했습니다.");
  const directory = join(home, "projects", parent.split(/[\\/]/).at(-2)!);
  await privateDirectory(home); await privateDirectory(join(home, "projects")); await privateDirectory(directory);
  const audit = join(auditRoot, `claude-rewind-${id}-${randomUUID()}`);
  await privateDirectory(auditRoot); await privateDirectory(audit);
  await atomicWrite(join(audit, "verification.json"), JSON.stringify({ sessionId: id, parentSessionId: branch.fork.sessionId, cutMessageId: branch.origins[length - 1], messages: length, verifiedAt: new Date().toISOString() }));
  const temporary = join(directory, `${id}.${randomUUID()}.tmp`), destination = join(directory, `${id}.jsonl`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    const staged = await scan(temporary);
    if (staged.fileHash !== branch.fileHash) throw new AccountError("복구 중 대화 기록이 변경되어 자동 복구를 보류했습니다.");
    await atomicWrite(join(audit, "transcript.jsonl"), await readFile(temporary));
    // No replacement: even a concurrently created transcript belongs to the user's new work.
    try { await link(temporary, destination); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const present = await scan(destination); return { status: "present" as const, messages: present.hashes.length };
    }
    return { status: "repaired" as const, messages: length };
  } finally { await rm(temporary, { force: true }); }
}

export class ProfileHistoryGuard {
  private seen = new Map<string, string>();
  private running = new Map<string, Promise<void>>();
  private stop?: () => void;
  private release?: () => Promise<void>;
  private disposed = false;
  constructor(private accounts: AccountManager) {}
  async start(paseo: PaseoApi) {
    this.stop = paseo.agents.subscribe(event => {
      if (event.kind === "upsert" && event.agent.provider === "claude" && ["idle", "error"].includes(event.agent.status) &&
        this.seen.get(event.agent.id) !== event.agent.persistence?.sessionId) void this.inspect(event.agent.id, paseo);
    });
    const page = await paseo.agents.list({ subscribe: {}, page: { limit: 100 } });
    this.release = () => page.subscription.release();
    if (this.disposed) { await this.release(); return; }
    await Promise.all(page.entries.map(e => this.inspect(e.agent.id, paseo)));
    if (this.disposed) return;
    page.subscription.subscribe({ snapshot: p => p.entries.forEach(e => { void this.inspect(e.agent.id, paseo); }), update: () => {} });
  }
  inspect(id: string, paseo: PaseoApi): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.running.get(id); if (existing) return existing;
    const work = this.check(id, paseo).finally(() => { this.running.delete(id); });
    this.running.set(id, work); return work;
  }
  private async check(id: string, paseo: PaseoApi) {
    let sessionId: string | null = null;
    try {
      const state = await this.accounts.store.read(), binding = state.bindings[id];
      if (!binding?.accountId || binding.harness !== "claude") return;
      const current = (await paseo.agents.ref(id).refresh())?.agent;
      sessionId = current?.persistence?.sessionId ?? null;
      if (!current || current.provider !== "claude" || current.archivedAt || current.activeTurn || current.pendingPermissions?.length ||
        !["idle", "error"].includes(current.status) || !sessionId || !uuid.test(sessionId) || this.seen.get(id) === sessionId) return;
      const result = await repairClaudeFork(binding.home, this.accounts.adapters.claude.systemHome, sessionId, join(this.accounts.store.root, "history-recovery"));
      const latest = (await paseo.agents.ref(id).refresh())?.agent;
      if (this.disposed || latest?.persistence?.sessionId !== sessionId) return;
      const emptyView = result.status === "present" && result.messages > 0 &&
        !(await paseo.agents.ref(id).timeline.refetch({ direction: "tail", projection: "canonical", limit: 1 })).entries.length;
      if (result.status === "repaired" || emptyView) {
        await this.accounts.store.update(s => {
          if (s.bindings[id]?.home !== binding.home || s.bindings[id]?.accountId !== binding.accountId) return;
          s.historyRecovery[id] = { sessionId: sessionId!, status: "recovered", message: "되감기 대화 기록을 현재 계정 프로필에서 복구했습니다.", updatedAt: new Date().toISOString() };
          if (!s.pending[id]) s.pending[id] = { error: null };
        });
        await this.accounts.applyPending(id, paseo);
      } else if (state.historyRecovery[id]?.sessionId === sessionId && state.historyRecovery[id].status === "blocked" && result.status === "present") {
        await this.accounts.store.update(s => { delete s.historyRecovery[id]; });
      }
      if (result.status !== "missing") this.seen.set(id, sessionId);
    } catch (error) {
      if (sessionId && !this.disposed) {
        await this.accounts.store.update(s => { s.historyRecovery[id] = { sessionId: sessionId!, status: "blocked", message: this.accounts.publicError(error), updatedAt: new Date().toISOString() }; }).catch(() => {});
        this.seen.set(id, sessionId);
      }
    }
  }
  dispose() { this.disposed = true; this.stop?.(); void this.release?.(); }
}
