import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { constants } from "node:fs";
interface Lease { handle: FileHandle; path: string; name: string; mime: string; size: number; mtime: number; expires: number; active: number; download: boolean; base: string; }
export class FileLinks {
 private server: Server | null = null; private ready: Promise<void> | null = null;
 private leases = new Map<string, Lease>(); private address = "127.0.0.1"; private port = 0;
 private timer = setInterval(() => { this.prune(); }, 30000);
 constructor() { this.timer.unref(); }
 private prune() { for (const [key, lease] of this.leases) if (lease.expires < Date.now() && !lease.active) { this.leases.delete(key); void lease.handle.close().catch(() => {}); } }
 private start() {
  if (this.ready) return this.ready;
  const addresses = Object.values(networkInterfaces()).flat().filter(row => row && row.family === "IPv4" && !row.internal).map(row => row!.address);
  // Bind a single private address; never expose a listener on every network interface.
  this.address = addresses.find(ip => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) || addresses.find(ip => /^192\.168\.|^10\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(ip)) || "127.0.0.1";
  this.ready = new Promise<void>((resolve, reject) => {
   const server = createServer((req, res) => { void this.serve(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); }); this.server = server;
   const listen = (port: number) => {
    const onError = (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE" && port) listen(0); else { this.ready = null; reject(new Error("파일 URL 서버를 시작하지 못했습니다.")); } };
    server.once("error", onError); server.listen(port, this.address, () => { server.removeListener("error", onError); const addr = server.address(); if (addr && typeof addr !== "string") this.port = addr.port; resolve(); });
   }; listen(17767);
  }); return this.ready;
 }
 async issue(path: string, name: string, mime: string, download: boolean, base: string | null) {
  await this.start(); this.prune(); const origin = base || `http://${this.address}:${this.port}`;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
   const stat = await handle.stat(); if (!stat.isFile()) throw new Error("일반 파일만 URL로 열 수 있습니다.");
   const response = (key: string, expires: number) => ({ url: `${origin.replace(/\/$/, "")}/file/${key}/${encodeURIComponent(name)}`, expiresAt: new Date(expires).toISOString(), size: stat.size, mime, baseUrl: origin });
   for (const [key, lease] of this.leases) if (lease.path === path && lease.name === name && lease.size === stat.size && lease.mtime === stat.mtimeMs && lease.download === download && lease.base === origin && lease.expires > Date.now() + 5 * 60000) { await handle.close(); return response(key, lease.expires); }
   if (this.leases.size >= 64) throw new Error("열린 미리보기가 너무 많습니다. 잠시 뒤 다시 시도하세요.");
   const key = randomBytes(32).toString("hex"), expires = Date.now() + 30 * 60000;
   this.leases.set(key, { handle, path, name, mime, size: stat.size, mtime: stat.mtimeMs, expires, active: 0, download, base: origin }); return response(key, expires);
  } catch (error) { await handle.close(); throw error; }
 }
 private async serve(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  const match = /^\/file\/([a-f0-9]{64})\/[^/?]+$/.exec((req.url || "").split("?")[0]); const lease = match ? this.leases.get(match[1]) : null;
  if (!lease || lease.expires < Date.now()) { res.writeHead(403); res.end("Link expired or unavailable"); return; }
  lease.active++; let finished = false;
  const done = () => { if (!finished) { finished = true; lease.active--; } }; res.once("close", done); res.once("finish", done);
  try {
   const stat = await lease.handle.stat(); if (stat.size !== lease.size || stat.mtimeMs !== lease.mtime) { res.writeHead(409); res.end("File changed"); return; }
   let start = 0, end = lease.size - 1; const range = req.headers.range;
   const invalidRange = () => { res.writeHead(416, { "Content-Range": `bytes */${lease.size}` }); res.end(); };
   if (range) {
    const parts = /^bytes=(\d*)-(\d*)$/.exec(range); if (!parts || (!parts[1] && !parts[2])) { invalidRange(); return; }
    if (parts[1]) { start = Number(parts[1]); if (parts[2]) end = Math.min(end, Number(parts[2])); }
    else { const suffix = Number(parts[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) { invalidRange(); return; } start = Math.max(0, lease.size - suffix); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= lease.size) { invalidRange(); return; }
   }
   res.setHeader("Content-Type", lease.mime); res.setHeader("Accept-Ranges", "bytes");
   res.setHeader("Content-Disposition", `${lease.download ? "attachment" : "inline"}; filename="${lease.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(lease.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`);
   // Even mislabeled HTML/SVG cannot run scripts or navigate the browser.
   res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; media-src 'self' blob:; img-src 'self' data:; object-src 'self'; style-src 'unsafe-inline'");
   res.setHeader("Content-Length", Math.max(0, end - start + 1)); if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${lease.size}`);
   res.writeHead(range ? 206 : 200); if (req.method === "HEAD" || !lease.size) { res.end(); return; }
   // FileHandle streams close the shared descriptor on destroy, even with autoClose:false.
   // Positional reads let independent range requests share a snapshot without closing it.
   const stream = Readable.from((async function* () {
    let offset = start;
    while (offset <= end) { const buffer = Buffer.alloc(Math.min(256 * 1024, end - offset + 1)); const { bytesRead } = await lease.handle.read(buffer, 0, buffer.length, offset); if (!bytesRead) throw new Error("File changed during stream"); offset += bytesRead; yield buffer.subarray(0, bytesRead); }
   })()); res.once("close", () => stream.destroy()); stream.once("error", () => res.destroy()); stream.pipe(res);
  } catch { done(); throw new Error("File stream failed"); }
 }
 async dispose() { clearInterval(this.timer); this.server?.closeAllConnections(); if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve())); await Promise.allSettled([...this.leases.values()].map(row => row.handle.close())); this.leases.clear(); }
}
