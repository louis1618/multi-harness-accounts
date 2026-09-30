import { open, lstat } from "node:fs/promises";
import { basename, join, isAbsolute } from "node:path";
import { type AccountSession, type Harness } from "../shared/accounts.js";
import { filesUnder } from "./adapters.js";

const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export async function nativeSessions(home: string, harness: Harness, accountId: string | null): Promise<AccountSession[]> {
  const paths = harness === "codex"
    ? [...await filesUnder(join(home, "sessions")), ...await filesUnder(join(home, "archived_sessions"))]
    : await filesUnder(join(home, "projects"));
  const candidates: { path: string; updatedAt: string }[] = [];
  for (const path of paths) {
    if (!path.endsWith(".jsonl") || harness === "claude" && path.includes("/subagents/")) continue;
    const stat = await lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink()) candidates.push({ path, updatedAt: stat.mtime.toISOString() });
  }
  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sessions: AccountSession[] = [];
  // ponytail: show recent 300 transcripts per home; add a native title index if older-history search is needed.
  for (const candidate of candidates.slice(0, 300)) {
    const file = await open(candidate.path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
    let sessionId: string | null = harness === "claude" ? basename(candidate.path, ".jsonl") : null;
    let cwd = "", title = "";
    for (const line of text.split("\n")) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (harness === "codex") {
        if (row.type === "session_meta") {
          if (validId(row.payload?.id)) sessionId = row.payload.id;
          if (typeof row.payload?.cwd === "string") cwd = row.payload.cwd;
        }
        if (!title && row.type === "event_msg" && row.payload?.type === "user_message" && typeof row.payload.message === "string") title = row.payload.message;
      } else {
        if (typeof row.cwd === "string") cwd = row.cwd;
        if (row.type === "summary" && typeof row.summary === "string") title = row.summary;
        if (!title && row.type === "user") {
          const content = row.message?.content;
          if (typeof content === "string") title = content;
          else if (Array.isArray(content)) title = content.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join(" ");
        }
      }
      if (sessionId && cwd && title) break;
    }
    if (!validId(sessionId) || !isAbsolute(cwd) || harness === "codex" && !candidate.path.endsWith(`-${sessionId}.jsonl`)) continue;
    sessions.push({ id: `native:${harness}:${accountId ?? "system"}:${sessionId}`,
      harness, title: title.trim().replace(/\s+/g, " ").slice(0, 240) || `${harness === "codex" ? "Codex" : "Claude Code"} 세션 ${sessionId.slice(0, 8)}`,
      cwd, updatedAt: candidate.updatedAt, source: "native", agentId: null, accountId, nativeSessionId: sessionId });
  }
  return sessions;
}
