import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const path = z.string().max(4096).refine(value => !value.includes("\0"), "경로가 올바르지 않습니다.");
const name = z.string().trim().min(1).max(255).refine(value => !/[\/\\\0]/.test(value) && value !== "." && value !== "..", "파일 이름이 올바르지 않습니다.");
export const EntrySchema = z.object({ path, name: z.string(), kind: z.enum(["folder", "file", "link", "other"]), size: z.number().nonnegative(), modifiedAt: z.string(), extension: z.string(), accessible: z.boolean(), favorite: z.boolean(), originalPath: path.optional(), deletedAt: z.string().optional() });
export type Entry = z.infer<typeof EntrySchema>;
export const favoriteSchema = z.object({ path, name: z.string(), kind: z.enum(["folder", "file", "link", "other"]) });
export const listRpc = defineRpc({ name: "files.list", input: z.object({ path: path.default(""), hidden: z.boolean().default(true), trash: z.boolean().default(false) }), output: z.object({ home: path, path, entries: z.array(EntrySchema), favorites: z.array(favoriteSchema), shortcuts: z.array(favoriteSchema), errors: z.number().int().nonnegative() }) });
export const actionRpc = defineRpc({ name: "files.change", input: z.discriminatedUnion("action", [
 z.object({ action: z.literal("rename"), path, name }), z.object({ action: z.literal("mkdir"), path, name }),
 z.object({ action: z.literal("favorite"), path, enabled: z.boolean() }),
 z.object({ action: z.literal("trash"), paths: z.array(path).min(1).max(200), confirmed: z.literal(true) }),
 z.object({ action: z.literal("restore"), paths: z.array(path).min(1).max(200) }),
 z.object({ action: z.literal("copy"), paths: z.array(path).min(1).max(200), destination: path, move: z.boolean() }),
 ]), output: z.object({ message: z.string(), completed: z.array(path), errors: z.array(z.object({ path, message: z.string() })) }) });
export const previewRpc = defineRpc({ name: "files.preview", input: z.object({ path }), output: z.object({ text: z.string().nullable(), dataUrl: z.string().nullable(), message: z.string().nullable(), kind: z.string().default("text"), url: z.string().nullable().default(null), pages: z.array(z.string()).default([]) }) });
export const linkRpc = defineRpc({ name: "files.link", input: z.object({ path, download: z.boolean().default(true) }), output: z.object({ url: z.string(), expiresAt: z.string(), size: z.number(), mime: z.string(), baseUrl: z.string() }) });
export const urlSettingRpc = defineRpc({ name: "files.url-setting", input: z.object({ baseUrl: z.union([z.string().url().max(2048), z.null()]).optional() }), output: z.object({ baseUrl: z.string().nullable() }) });
export function formatBytes(size: number) { if (!size) return "0 바이트"; const unit = Math.min(3, Math.floor(Math.log(size) / Math.log(1024))); return `${(size / 1024 ** unit).toLocaleString("ko-KR", { maximumFractionDigits: unit ? 1 : 0 })} ${["바이트", "KB", "MB", "GB"][unit]}`; }
