import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  chmod,
  writeFile,
  rename,
  rm,
  readFile,
} from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { relative, isAbsolute } from "node:path";
export class CareError extends Error {}
export const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export function inside(root: string, p: string) {
  const r = relative(root, p);
  return !!r && !isAbsolute(r) && r !== ".." && !r.startsWith("../");
}
export async function directory(p: string) {
  await mkdir(p, { recursive: true, mode: 0o700 });
  const s = await lstat(p);
  if (!s.isDirectory() || s.isSymbolicLink())
    throw new CareError("저장 경로가 안전하지 않습니다.");
  await chmod(p, 0o700);
}
export async function atomic(p: string, data: string) {
  const tmp = p + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
    await rename(tmp, p);
  } finally {
    await rm(tmp, { force: true });
  }
}
export async function jsonFile(p: string, fallback: unknown) {
  try {
    const s = await lstat(p);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 4 * 1024 * 1024)
      throw Error();
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new CareError("저장 파일을 읽지 못했습니다. 원본을 보존했습니다.");
  }
}
export function redact(text: string, values: string[] = []) {
  let s = text;
  for (const v of values.filter(Boolean).sort((a, b) => b.length - a.length))
    s = s.split(v).join("[숨김]");
  s = s
    .replace(/(?:Bearer\s+)[\w.+\/-]+/gi, "Bearer [숨김]")
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|token|password|secret|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"';]+/gi,
      "$1[숨김]",
    )
    .replace(
      /\b(?:sk-(?:ant-|proj-)?[\w-]{16,}|gh[pousr]_[\w]{16,}|eyJ[\w-]+\.eyJ[\w.-]+)\b/g,
      "[숨김]",
    );
  return s;
}
export type Run = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number }>;
export class Runner {
  children = new Set<ChildProcess>();
  async run(command: string, args: string[], options: Parameters<Run>[2] = {}) {
    const p = promisify(execFile)(command, args, {
      timeout: options.timeout ?? 20000,
      maxBuffer: 8 * 1024 * 1024,
      signal: options.signal,
      env: options.env ?? {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME,
        LANG: "C",
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      },
    });
    this.children.add(p.child);
    try {
      const r = await p;
      return { ...r, code: 0 };
    } catch (e) {
      const err = e as any;
      if (options.signal?.aborted) throw new CareError("작업을 취소했습니다.");
      return {
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? ""),
        code: typeof err.code === "number" ? err.code : 1,
      };
    } finally {
      this.children.delete(p.child);
    }
  }
  dispose() {
    for (const c of this.children) c.kill("SIGTERM");
  }
}
