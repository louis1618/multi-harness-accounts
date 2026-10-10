import { constants } from "node:fs";
import { open, readdir, lstat, stat, realpath, mkdir, rename, cp, readFile, writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join, relative, basename, dirname, extname, sep, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import { actionRpc, listRpc, previewRpc, linkRpc, urlSettingRpc, favoriteSchema, type Entry } from "../shared/files.js";
const execute = promisify(execFile);
function binaryHeader(data: Buffer) { const lines = []; for (let offset = 0; offset < Math.min(512, data.length); offset += 16) { const row = data.subarray(offset, offset + 16); lines.push(offset.toString(16).padStart(6, "0") + "  " + [...row].map(byte => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47) + "  " + [...row].map(byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("")); } return lines.join("\n"); }

import { fileFormat } from "../shared/formats.js";
import { FileLinks } from "./links.js";
import { documentText } from "./documents.js";
const preferences = z.object({ favorites: z.array(favoriteSchema).max(500), baseUrl: z.string().nullable().default(null) });
function friendly(error: unknown) { const code = (error as NodeJS.ErrnoException)?.code; return code === "EACCES" || code === "EPERM" ? "접근 권한이 없습니다." : code === "ENOENT" ? "항목을 찾을 수 없습니다. 새로고침하세요." : code === "EEXIST" ? "같은 이름의 항목이 이미 있습니다." : error instanceof Error && error.name === "FinderError" ? error.message : "작업을 완료하지 못했습니다. 권한과 경로를 확인하세요."; }
function fail(message: string): never { const error = new Error(message); error.name = "FinderError"; throw error; }
export class HomeFiles {
 readonly home: string;
 private links = new FileLinks();
 private storage: string;
 private trash: string;
 private queue: Promise<unknown> = Promise.resolve();
 constructor(home = homedir(), storage = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "home-finder")) {
  this.home = resolve(home); this.storage = storage;
  const xdg = process.env.XDG_DATA_HOME; this.trash = join(xdg && this.inside(resolve(xdg)) ? xdg : join(this.home, ".local/share"), "Trash");

 }
 private inside(path: string) { const p = relative(this.home, path); return p === "" || !isAbsolute(p) && p !== ".." && !p.startsWith(`..${sep}`); }
 private lexical(path: string) { const target = resolve(this.home, path || "."); if (!this.inside(target) || path.includes("\0")) fail("홈 폴더 밖으로 이동할 수 없습니다."); return target; }
 async checked(path: string, follow = true) {
  const target = this.lexical(path); const resolved = await realpath(follow || target === this.home ? target : dirname(target));
  const root = await realpath(this.home); const p = relative(root, resolved);
  if (isAbsolute(p) || p === ".." || p.startsWith(`..${sep}`)) fail("홈 폴더 밖을 가리키는 링크에는 접근할 수 없습니다.");
  return target;
 }
 private relative(path: string) { return relative(this.home, path).split(sep).join("/"); }
 private async readPreferences() { try { return preferences.parse(JSON.parse(await readFile(join(this.storage, "state.json"), "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { favorites: [], baseUrl: null }; fail("즐겨찾기를 읽지 못했습니다. 저장 파일을 확인하세요."); } }
 private async savePreferences(state: z.infer<typeof preferences>) {
  await mkdir(this.storage, { recursive: true, mode: 0o700 }); const destination = join(this.storage, "state.json");
  const temp = `${destination}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  try { await rename(temp, destination); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
 }
 private async entry(path: string, favorites: Set<string>): Promise<Entry> {
  const metadata = await lstat(path); let accessible = true; let target = metadata;
  if (metadata.isSymbolicLink()) { try { await this.checked(path); target = await stat(path); } catch { accessible = false; } }
  const kind = metadata.isSymbolicLink() && !accessible ? "link" : target.isDirectory() ? "folder" : metadata.isSymbolicLink() ? "link" : target.isFile() ? "file" : "other";
  return { path: this.relative(path), name: basename(path), kind, size: target.isFile() ? target.size : 0, modifiedAt: metadata.mtime.toISOString(), extension: extname(path).toLowerCase(), accessible: accessible && (target.isDirectory() || target.isFile()), favorite: favorites.has(this.relative(path)) };
 }
 async list(input: RpcInput<typeof listRpc>) {
  try {
   const state = await this.readPreferences(); const favorites = new Set(state.favorites.map(row => row.path));
   const directory = input.trash ? await this.trashDirectory() : await this.checked(input.path);
   if (!(await stat(directory)).isDirectory()) fail("폴더를 선택하세요.");
   const entries: Entry[] = []; let errors = 0;
   // ponytail: bounded parallel stat batches; paginate if a single folder exceeds 50,000 entries.
   const names = await readdir(directory); if (names.length > 50000) fail("항목이 너무 많습니다. 더 작은 폴더에서 탐색하세요.");
   for (let i = 0; i < names.length; i += 64) {
    const rows = await Promise.allSettled(names.slice(i, i + 64).filter(name => input.hidden || input.trash || !name.startsWith(".")).map(async name => {
     const row = await this.entry(join(directory, name), favorites);
     if (input.trash) { const info = await this.trashInfo(name); row.name = basename(info.original); row.originalPath = this.relative(info.original); row.deletedAt = info.date; }
     return row;
    })); for (const row of rows) if (row.status === "fulfilled") entries.push(row.value); else errors++;
   }
   const shortcuts = [{ path: "", name: basename(this.home), kind: "folder" as const }];
   for (const [path, name] of [["Desktop", "데스크탑"], ["Documents", "문서"], ["Downloads", "다운로드"], ["Pictures", "사진"], ["Music", "음악"], ["Videos", "동영상"]]) {
    try { const target = await this.checked(path); if ((await stat(target)).isDirectory()) shortcuts.push({ path, name, kind: "folder" }); } catch { /* Optional folders. */ }
   }
   return { home: this.home, path: this.relative(directory), entries, favorites: state.favorites, shortcuts, errors };
  } catch (error) { fail(friendly(error)); }
 }
 private async makeDirectory(path: string) {
  let ancestor = this.lexical(path);
  while (true) { try { await this.checked(ancestor); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); } }
  await mkdir(path, { recursive: true, mode: 0o700 }); await this.checked(path);
 }
 private async trashDirectory() { if (process.platform !== "linux") fail("현재 휴지통 기능은 Linux 호스트에서 지원합니다."); await this.makeDirectory(join(this.trash, "files")); await this.makeDirectory(join(this.trash, "info")); await this.checked(join(this.trash, "info")); return this.checked(join(this.trash, "files")); }
 private async trashInfo(name: string) {
  if (name !== basename(name)) fail("휴지통 항목이 올바르지 않습니다.");
  const infoPath = await this.checked(join(this.trash, "info", `${name}.trashinfo`)); const data = await readFile(infoPath, "utf8");
  const encoded = /^Path=(.*)$/m.exec(data)?.[1]; if (!encoded) fail("원래 위치를 찾지 못했습니다.");
  const original = this.lexical(decodeURIComponent(encoded)); if (original === this.home) fail("홈 폴더는 복원할 수 없습니다.");
  return { original, infoPath, date: /^DeletionDate=(.*)$/m.exec(data)?.[1] || "" };
 }
 change(input: RpcInput<typeof actionRpc>) {
  // ponytail: serialize filesystem mutations and favorites together; per-directory queues if concurrent use grows.
  const result = this.queue.then(() => this.mutate(input)); this.queue = result.catch(() => {}); return result;
 }
 private async mutate(input: RpcInput<typeof actionRpc>) {
  const completed: string[] = []; const errors: { path: string; message: string }[] = [];
  const paths = "paths" in input ? [...new Set(input.paths)] : [input.path];
  for (const path of paths) {
   try {
    if (input.action === "favorite" && !input.enabled) {
     this.lexical(path); const state = await this.readPreferences(); state.favorites = state.favorites.filter(row => row.path !== path); await this.savePreferences(state); completed.push(path); continue;
    }
    const source = await this.checked(path, input.action === "favorite" || input.action === "copy");
    if (source === this.home && input.action !== "favorite" && input.action !== "mkdir") fail("홈 폴더 자체는 변경할 수 없습니다.");
    if (input.action === "favorite") {
     const state = await this.readPreferences(); state.favorites = state.favorites.filter(row => row.path !== path);
     if (input.enabled) { const row = await this.entry(source, new Set()); state.favorites.push({ path: row.path, name: row.name, kind: row.kind }); }
     await this.savePreferences(preferences.parse(state));
    } else if (input.action === "trash") {
     const trashRoot = resolve(this.trash); if (source === trashRoot || source.startsWith(trashRoot + sep) || trashRoot.startsWith(source + sep)) fail("휴지통 폴더 자체는 삭제할 수 없습니다.");
     await this.trashDirectory(); await execute("gio", ["trash", "--", source], { timeout: 30000, maxBuffer: 16384, env: { ...process.env, XDG_DATA_HOME: dirname(this.trash) } });
    } else if (input.action === "restore") {
     if (dirname(source) !== join(this.trash, "files")) fail("휴지통에서 복원할 항목을 선택하세요.");
     const info = await this.trashInfo(basename(source)); await this.checked(dirname(info.original)); await this.unused(info.original);
     await rename(source, info.original); await unlink(info.infoPath);
    } else {
     const target = input.action === "rename" ? join(dirname(source), input.name) : input.action === "mkdir" ? join(source, input.name) : join(await this.checked(input.destination), basename(source));
     await this.checked(dirname(target)); await this.unused(target);
     if (input.action === "mkdir" && !(await stat(source)).isDirectory()) fail("새 폴더를 만들 위치가 폴더가 아닙니다.");
     if (input.action === "mkdir") await mkdir(target);
     else {
      if (input.action === "copy" && (target === source || target.startsWith(source + sep))) fail("폴더를 자기 내부로 복사하거나 이동할 수 없습니다.");
      const state = input.action === "rename" || input.move ? await this.readPreferences() : null;
      if (input.action === "rename" || input.move) await rename(source, target);
      else await cp(source, target, { recursive: true, force: false, errorOnExist: true, dereference: false });
      if (state) { const old = this.relative(source), next = this.relative(target); state.favorites = state.favorites.map(row => row.path === old || row.path.startsWith(old + "/") ? { ...row, path: next + row.path.slice(old.length), name: row.path === old ? basename(target) : row.name } : row); await this.savePreferences(state); }
     }
    }
    completed.push(path);
   } catch (error) { errors.push({ path, message: friendly(error) }); }
  }
  return { completed, errors, message: errors.length ? `${completed.length}개 완료 · ${errors.length}개 실패` : input.action === "trash" ? `${completed.length}개 항목을 휴지통으로 이동했습니다.` : input.action === "restore" ? `${completed.length}개 항목을 복원했습니다.` : "완료했습니다." };
 }
 private async unused(path: string) { try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } fail("같은 이름의 항목이 이미 있습니다. 다른 이름을 사용하세요."); }
 async urlSetting(input: RpcInput<typeof urlSettingRpc>) {
  if (input.baseUrl === undefined) return { baseUrl: (await this.readPreferences()).baseUrl };
  const result = this.queue.then(async () => {
   let baseUrl = input.baseUrl;
   if (baseUrl) { const url = new URL(baseUrl); if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) fail("HTTP 또는 HTTPS 주소만 입력하세요. 인증 정보·쿼리는 사용할 수 없습니다."); baseUrl = url.href.replace(/\/$/, ""); }
   const state = await this.readPreferences(); state.baseUrl = baseUrl ?? null; await this.savePreferences(state); return { baseUrl: state.baseUrl };
  }); this.queue = result.catch(() => {}); return result;
 }
 async link(input: RpcInput<typeof linkRpc>) {
  const target = await realpath(await this.checked(input.path)); const { mime } = fileFormat(input.path);
  return this.links.issue(target, basename(input.path), mime, input.download, (await this.readPreferences()).baseUrl);
 }
 async preview({ path }: RpcInput<typeof previewRpc>) {
  try {
   const target = await realpath(await this.checked(path)); const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
   const result = { text: null as string | null, dataUrl: null as string | null, message: null as string | null, kind: fileFormat(path).kind as string, url: null as string | null, pages: [] as string[] };
   try {
    const meta = await handle.stat(); if (!meta.isFile()) return { ...result, message: "폴더 또는 특수 파일은 미리볼 수 없습니다." };
    const { kind, mime } = fileFormat(path);
    if (["image", "video", "audio", "pdf"].includes(kind)) {
     // Small common images remain available over the existing authenticated RPC on relay-only connections.
     if (kind === "image" && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(path) && meta.size <= 5 * 1024 * 1024) result.dataUrl = `data:${mime};base64,${(await handle.readFile()).toString("base64")}`;
     try { result.url = (await this.link({ path, download: false })).url; } catch { result.message = "파일 URL을 만들지 못했습니다. 연결 설정을 확인하거나 미리보기를 다시 불러오세요."; }
     if (kind === "pdf" && meta.size <= 50 * 1024 * 1024) {
      const dir = await mkdtemp(join(tmpdir(), "finder-pdf-"));
      try { await execute("pdftoppm", ["-f", "1", "-l", "3", "-scale-to", "1000", "-png", target, join(dir, "page")], { timeout: 12000, maxBuffer: 16384 });
       for (const name of (await readdir(dir)).filter(name => name.endsWith(".png")).sort()) { const data = await readFile(join(dir, name)); if (data.length < 2 * 1024 * 1024) result.pages.push(`data:image/png;base64,${data.toString("base64")}`); }
      } catch { /* The full PDF remains available through its temporary URL. */ } finally { await rm(dir, { recursive: true, force: true }); }
     }
     if (result.pages.length) result.message = "앞부분 최대 3페이지입니다. 전체 문서는 브라우저에서 열 수 있습니다.";
     return result;
    }
    if (kind === "office" || kind === "archive") {
     result.text = await documentText(target); result.message = result.text === null ? "이 문서·압축 형식은 다운로드하여 열어주세요." : kind === "office" ? "문서의 텍스트·셀 내용을 표시합니다. 서식·수식은 실행하지 않습니다." : "압축을 풀지 않고 앞부분 최대 300개 항목을 표시합니다.";
     return result;
    }
    const buffer = Buffer.alloc(Math.min(meta.size, 131072)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); const data = buffer.subarray(0, bytesRead);
    const utf16 = data[0] === 0xff && data[1] === 0xfe || data[0] === 0xfe && data[1] === 0xff; const utf16Data = data.subarray(2, data.length - data.length % 2); let text: string; try { text = utf16 ? (data[0] === 0xfe ? utf16Data.swap16() : utf16Data).toString("utf16le") : new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: meta.size > buffer.length }); } catch { return { ...result, kind: "binary", text: binaryHeader(data), message: "바이너리 앞부분 최대 512바이트입니다. 전체 내용은 전용 앱에서 열어주세요." }; }
    if (!utf16 && data.includes(0)) return { ...result, kind: "binary", text: binaryHeader(data), message: "바이너리 앞부분 최대 512바이트입니다. 전체 내용은 전용 앱에서 열어주세요." };
    return { ...result, kind: "text", text, message: meta.size > 131072 ? "앞부분 128KB만 표시합니다." : null };
   } finally { await handle.close(); }
  } catch (error) { fail(friendly(error)); }
 }
 async dispose() { await this.links.dispose(); }
}
