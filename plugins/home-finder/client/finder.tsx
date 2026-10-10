import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, openExternalUrl } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, FlatList, useToast, copyText } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View, Text, Pressable, ScrollView, Image, ActivityIndicator, Platform, type ViewStyle, type GestureResponderEvent, type FlatList as NativeFlatList } from "react-native";
import { actionRpc, listRpc, previewRpc, linkRpc, urlSettingRpc, formatBytes, type Entry } from "../shared/files";
import { keyboard, modifiers, contextProps } from "./web";
import { MediaPreview } from "./media";
import { fileFormat } from "../shared/formats";
type Mode = "icons" | "list" | "columns" | "gallery";
type Dialog = "rename" | "mkdir" | "trash" | "goto" | "sort" | "actions" | "download" | "url" | null;
const modes: { value: Mode; icon: string; label: string }[] = [{ value: "icons", icon: "LayoutGrid", label: "아이콘 보기" }, { value: "list", icon: "List", label: "목록 보기" }, { value: "columns", icon: "Columns3", label: "열 보기" }, { value: "gallery", icon: "GalleryHorizontalEnd", label: "갤러리 보기" }];
function parent(path: string) { return path.split("/").slice(0, -1).join("/"); }
function kind(entry: Entry) { return entry.kind === "folder" ? "폴더" : entry.kind === "link" ? "연결" : entry.extension ? entry.extension.slice(1).toUpperCase() + " 파일" : "파일"; }
function date(value: string) { return new Date(value).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function FileIcon({ entry, size = 24 }: { entry: Pick<Entry, "kind" | "extension">; size?: number }) {
 if (entry.kind === "folder") return <View style={{ width: size * 1.2, height: size, justifyContent: "flex-end" }}><View style={{ position: "absolute", top: 1, left: 1, width: size * .52, height: size * .25, backgroundColor: "#389bd7", borderTopLeftRadius: 3, borderTopRightRadius: 3 }} /><View style={{ height: size * .78, borderRadius: Math.max(2, size * .06), backgroundColor: "#60baf0", borderTopWidth: Math.max(1, size * .06), borderTopColor: "#90d6ff" }} /></View>;
 const format = fileFormat(entry.extension); const image = format.kind === "image", archive = format.kind === "archive";
 return <Icon name={entry.kind === "link" ? "Link" : image ? "FileImage" : archive ? "FileArchive" : format.kind === "video" ? "FileVideo" : format.kind === "audio" ? "FileAudio" : entry.extension === ".pdf" ? "FileText" : "File"} size={size} color={entry.extension === ".pdf" ? "#d7544b" : image ? "#538894" : archive ? "#ae865c" : "#89939e"} />;
}
export function Finder({ theme, layout, host }: PluginSurfaceProps) {
 const list = useRpc(listRpc), change = useRpc(actionRpc), preview = useRpc(previewRpc), link = useRpc(linkRpc), urlSetting = useRpc(urlSettingRpc), toast = useToast();
 const c = useMemo(() => ({ ...theme.colors, accent: "#006ddb", accentForeground: "#ffffff" }), [theme.colors]), compact = layout.compact;
 const [location, setLocation] = useState(""); const [trash, setTrash] = useState(false); const [hidden, setHidden] = useState(true);
 const [failedImage, setFailedImage] = useState("");
 const [mode, setMode] = useState<Mode>("icons"), [search, setSearch] = useState(""), [sort, setSort] = useState<"name" | "date" | "size" | "kind">("name"), [descending, setDescending] = useState(false);
 const [contentWidth, setContentWidth] = useState(700);
 const [selected, setSelected] = useState<string[]>([]), [multi, setMulti] = useState(false), [sidebar, setSidebar] = useState(!compact), [inspector, setInspector] = useState(false);
 const [dialog, setDialog] = useState<Dialog>(null), [input, setInput] = useState(""), [busy, setBusy] = useState(false);
 const [clipboard, setClipboard] = useState<{ paths: string[]; move: boolean } | null>(null), [notice, setNotice] = useState<string | null>(null);
 const [downloadLinks, setDownloadLinks] = useState<{ path: string; name: string; url: string; expiresAt: string; baseUrl: string }[]>([]);
 const [searching, setSearching] = useState(false);
 const fileListRef = useRef<NativeFlatList<Entry>>(null);
 const history = useRef([{ path: "", trash: false }]); const historyIndex = useRef(0); const anchor = useRef<string | null>(null); const lastClick = useRef({ path: "", time: 0 }); const alive = useRef(true);
 useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
 const query = useQuery({ queryKey: ["home-finder", host.id, location, trash, hidden], queryFn: () => list({ path: location, hidden, trash }), refetchInterval: busy ? false : 15000 });
 const entries = useMemo(() => (query.data?.entries || []).filter(entry => entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => {
  if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
  const order = sort === "date" ? Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt) : sort === "size" ? a.size - b.size : sort === "kind" ? kind(a).localeCompare(kind(b), "ko") : a.name.localeCompare(b.name, "ko", { numeric: true }); return descending ? -order : order;
 }), [query.data, search, sort, descending]);
 useEffect(() => { if (query.data && !query.isFetching) { const paths = new Set(query.data.entries.map(row => row.path)); setSelected(rows => rows.every(path => paths.has(path)) ? rows : rows.filter(path => paths.has(path))); } }, [query.data, query.isFetching]);
 const picked = entries.filter(row => selected.includes(row.path)); const item = picked.length === 1 ? picked[0] : null;
 const ancestors = location ? ["", ...location.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))].slice(-2) : [];
 const columnQueries = useQueries({ queries: ancestors.map(path => ({ queryKey: ["home-finder", host.id, path, false, hidden], queryFn: () => list({ path, hidden, trash: false }), enabled: mode === "columns" && !trash })) });
 const previewQuery = useQuery({ queryKey: ["home-finder-preview", host.id, item?.path, item?.modifiedAt, inspector, mode], queryFn: () => preview({ path: item!.path }), staleTime: 5 * 60000, gcTime: 60000, refetchInterval: 20 * 60000, retry: false, enabled: !!item && item.kind !== "folder" && item.accessible && (inspector || mode === "gallery") });
 const downloadQuery = useQuery({ queryKey: ["home-finder-download-link", host.id, item?.path, item?.modifiedAt], queryFn: () => link({ path: item!.path, download: true }), enabled: !!item && item.kind !== "folder" && item.accessible, staleTime: 5 * 60000, gcTime: 60000, retry: false });
 const s = useMemo(() => ({
  screen: { flex: 1, backgroundColor: c.surface0 } as ViewStyle,
  chrome: { backgroundColor: c.surface1, borderBottomWidth: 1, borderColor: c.border, paddingHorizontal: compact ? 10 : 16, paddingVertical: compact ? 8 : 12, gap: 8 } as ViewStyle,
  row: { flexDirection: "row", alignItems: "center", gap: 6 } as ViewStyle,
  text: { color: c.foreground, fontSize: 13, lineHeight: 19 }, muted: { color: c.foregroundMuted, fontSize: 12 },
  line: { height: 1, backgroundColor: c.border, marginVertical: 10 } as ViewStyle,
  input: { color: c.foreground, fontSize: 13, backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 7, minWidth: 0 } as ViewStyle,
  bottom: { borderTopWidth: 1, borderColor: c.border, backgroundColor: c.surface1, paddingHorizontal: 16, paddingVertical: compact ? 4 : 5, gap: 2 } as ViewStyle,
 }), [c, compact]);
 function button(label: string, icon: string, onPress: () => void, disabled = false, active = false, showText = false, primary = false) {
  return <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={onPress} {...(Platform.OS === "web" ? { title: label } : {})}
   style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [s.row, { minHeight: compact || Platform.OS !== "web" || primary ? 44 : showText ? 36 : 34, minWidth: compact ? 44 : 34, paddingHorizontal: showText ? 10 : 6, borderRadius: 8, justifyContent: "center", opacity: disabled ? .35 : 1, backgroundColor: primary ? c.accent : active ? c.surface0 : pressed || hovered ? c.surface2 : "transparent" }]}>
   <Icon name={icon} size={18} color={primary ? c.accentForeground : active ? c.foreground : c.foregroundMuted} />{showText && <Text style={[s.text, { flexShrink: 1, color: primary ? c.accentForeground : c.foreground }]}>{label}</Text>}
  </Pressable>;
 }
 function navigate(path: string, toTrash = false, record = true) {
  if (query.data && (path === query.data.home || path.startsWith(query.data.home + "/"))) path = path.slice(query.data.home.length).replace(/^\//, "");
  setLocation(path); setTrash(toTrash); setSelected([]); setSearch(""); setNotice(null); anchor.current = null;
  if (record) { history.current = history.current.slice(0, historyIndex.current + 1); history.current.push({ path, trash: toTrash }); historyIndex.current++; }
  if (compact) setSidebar(false);
 }
 function travel(delta: number) { const index = historyIndex.current + delta; if (index >= 0 && index < history.current.length) { historyIndex.current = index; const next = history.current[index]; navigate(next.path, next.trash, false); } }
 function open(entry: Entry) { if (trash) { setInspector(true); return; } if (!entry.accessible) { toast.error("이 항목에 접근할 수 없습니다. 홈 외부 연결 또는 접근 권한을 확인하세요."); return; } if (entry.kind === "folder") navigate(entry.path); else if (entry.kind === "link") { void list({ path: entry.path, hidden, trash: false }).then(() => navigate(entry.path)).catch(() => { setInspector(true); }); } else setInspector(true); }
 function select(entry: Entry, event?: GestureResponderEvent) {
  const mods = event ? modifiers(event) : { range: false, additive: false }; const now = Date.now();
  if (!mods.additive && !mods.range && !multi && lastClick.current.path === entry.path && now - lastClick.current.time < 350 && !trash) { lastClick.current = { path: "", time: 0 }; open(entry); return; }
  lastClick.current = { path: entry.path, time: now };
  if (mods.range && anchor.current) { const a = entries.findIndex(row => row.path === anchor.current), b = entries.indexOf(entry); if (a >= 0) setSelected(entries.slice(Math.min(a, b), Math.max(a, b) + 1).map(row => row.path)); }
  else if (mods.additive || multi) setSelected(rows => rows.includes(entry.path) ? rows.filter(path => path !== entry.path) : [...rows, entry.path]);
  else setSelected([entry.path]);
  if (!mods.range) anchor.current = entry.path;
 }
 async function perform(action: Parameters<typeof change>[0]) {
  if (busy) return; setBusy(true); setNotice(null);
  try { const result = await change(action); setNotice(result.errors.length ? result.errors.map(row => `${row.path.split("/").pop()}: ${row.message}`).join("\n") : null);
   if (result.errors.length) toast.error(result.message); else toast.show(result.message);
   setSelected(rows => rows.filter(path => !result.completed.includes(path))); if (action.action === "copy" && action.move && !result.errors.length) setClipboard(null);
   if (!result.errors.length) setDialog(null); await query.refetch();
  } catch (error) { setNotice((error as Error).message); toast.error((error as Error).message); } finally { if (alive.current) setBusy(false); }
 }
 function begin(dialog: Dialog) { setNotice(null); setInput(dialog === "rename" ? item?.name || "" : dialog === "mkdir" ? "새 폴더" : dialog === "goto" ? location : ""); setDialog(dialog); }
 async function prepareDownload() {
  if (busy || !picked.length) return;
  setDownloadLinks([]); setNotice(null); setDialog("download");
  if (picked.length > 16) { setNotice("한 번에 16개 파일까지 다운로드할 수 있습니다. 선택을 줄여주세요."); return; }
  setBusy(true);
  try { const links = []; for (const entry of picked) { const result = await link({ path: entry.path, download: true }); links.push({ ...result, path: entry.path, name: entry.name }); } if (alive.current) setDownloadLinks(links); }
  catch { if (alive.current) setNotice("파일 URL을 만들지 못했습니다. 다시 시도하세요."); }
  finally { if (alive.current) setBusy(false); }
 }
 function startDownload() {
  if (busy || !picked.length || picked.some(row => row.kind === "folder" || !row.accessible)) return;
  const prepared = downloadQuery.data;
  if (item && prepared && Date.parse(prepared.expiresAt) > Date.now()) { setDialog(null); void external(prepared.url); return; }
  void prepareDownload();
 }
 async function copyLink(url: string) { try { await copyText(url); toast.show("다운로드 링크를 복사했습니다."); } catch { setNotice("링크를 복사하지 못했습니다. 다시 시도하세요."); } }
 async function external(url: string) { try { await openExternalUrl(url); } catch { toast.error("브라우저를 열지 못했습니다. URL을 복사하여 브라우저에서 열어주세요."); } }
 async function urlOptions() { setNotice(null); setInput(""); setDialog("url"); setBusy(true); try { setInput((await urlSetting({})).baseUrl || ""); } catch { setNotice("URL 설정을 읽지 못했습니다. 다시 시도하세요."); } finally { if (alive.current) setBusy(false); } }
 async function saveUrl() { setBusy(true); try { await urlSetting({ baseUrl: input.trim() || null }); setDownloadLinks([]); setDialog(null); await previewQuery.refetch(); toast.show("파일 URL 주소를 저장했습니다."); } catch { setNotice("HTTP 또는 HTTPS 주소를 확인하세요. 인증 정보·쿼리는 사용할 수 없습니다."); } finally { if (alive.current) setBusy(false); } }
 useEffect(() => keyboard(event => {
  if (dialog || busy) return false; const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "a") { setSelected(entries.map(row => row.path)); return true; }
  if (command && event.key.toLowerCase() === "c" && selected.length && !trash) { setClipboard({ paths: selected, move: false }); toast.show("항목을 복사했습니다. 대상 폴더에서 붙여넣으세요."); return true; }
  if (command && event.key.toLowerCase() === "x" && selected.length && !trash) { setClipboard({ paths: selected, move: true }); toast.show("항목을 이동할 준비가 되었습니다."); return true; }
  if (command && event.key.toLowerCase() === "v" && clipboard && !trash) { void perform({ action: "copy", paths: clipboard.paths, destination: location, move: clipboard.move }); return true; }
  if ((event.key === "Delete" || command && event.key === "Backspace") && selected.length && !trash) { begin("trash"); return true; }
  if (command && event.shiftKey && event.key.toLowerCase() === "n" && !trash) { begin("mkdir"); return true; }
  if (command && event.shiftKey && event.key.toLowerCase() === "g") { begin("goto"); return true; }
  if (command && event.shiftKey && event.key === ".") { setHidden(value => !value); return true; }
  if (command && event.key === "ArrowUp" && !trash && location) { navigate(parent(location)); return true; }
  if (event.altKey && event.key === "ArrowLeft") { travel(-1); return true; } if (event.altKey && event.key === "ArrowRight") { travel(1); return true; }
  if (command && /^[1-4]$/.test(event.key)) { setMode(modes[Number(event.key) - 1].value); return true; }
  if (command && event.key === "ArrowDown" && item) { if (!trash) open(item); return true; }
  if (event.key === "F2" && item && !trash) { begin("rename"); return true; } if (event.key === "Enter" && item) { if (!trash) begin("rename"); else setInspector(true); return true; }
  if (event.key === " " && item) { setInspector(value => !value); return true; }
  if (event.key === "Escape") { setSelected([]); setInspector(false); setMulti(false); return true; }
  if (["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key) && entries.length) {
   const index = Math.max(0, entries.findIndex(row => row.path === selected.at(-1))); const delta = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1; const next = entries[Math.max(0, Math.min(entries.length - 1, selected.length ? index + delta : 0))]; fileListRef.current?.scrollToOffset({ offset: mode === "icons" ? Math.floor(entries.indexOf(next) / Math.max(1, Math.floor((contentWidth - (compact ? 12 : 32)) / 120))) * 134 : entries.indexOf(next) * (compact ? 48 : 38), animated: false }); if (event.shiftKey && anchor.current) { const a = entries.findIndex(row => row.path === anchor.current), b = entries.indexOf(next); setSelected(entries.slice(Math.min(a, b), Math.max(a, b) + 1).map(row => row.path)); } else { setSelected([next.path]); anchor.current = next.path; } return true;
  }
  return false;
 }), [dialog, busy, selected, entries, clipboard, location, trash, item, mode, contentWidth]);
 function sideRow(name: string, icon: string, path: string, isTrash = false, favorite = false, file = false) {
  const active = isTrash ? trash : !trash && location === path;
  return <View key={`${isTrash ? "trash" : favorite ? "favorite" : "shortcut"}:${path}:${name}`} style={s.row}><Pressable accessibilityRole="button" accessibilityLabel={`${name}${file ? " 파일" : " 폴더"} 열기`} onPress={() => { if (file) { navigate(parent(path)); setSelected([path]); setInspector(true); } else navigate(path, isTrash); }} style={({ pressed }) => [s.row, { flex: 1, minHeight: compact ? 44 : 36, borderRadius: 7, paddingHorizontal: 10, backgroundColor: active || pressed ? c.surface2 : "transparent" }]}><Icon name={icon} size={17} color={isTrash ? c.foregroundMuted : c.accent} /><Text numberOfLines={1} style={[s.text, { flex: 1, fontWeight: active ? "600" : "400" }]}>{name}</Text></Pressable>{favorite && (active || file && selected.includes(path)) && button(`${name} 즐겨찾기 해제`, "X", () => { void perform({ action: "favorite", path, enabled: false }); }, busy)}</View>;
 }
 function fileItem(entry: Entry, view: "icons" | "list" | "columns", column = false, index = 0) {
  const active = column ? location === entry.path || location.startsWith(entry.path + "/") : selected.includes(entry.path);
  const icon = view === "icons" ? 52 : 21;
  return <Pressable key={entry.path} accessibilityRole="button" accessibilityLabel={`${entry.name}, ${kind(entry)}`} accessibilityState={{ selected: active }}
   onPress={event => column ? entry.kind === "folder" ? open(entry) : (navigate(parent(entry.path)), setSelected([entry.path]), setInspector(true)) : view === "columns" && entry.kind === "folder" && !trash ? open(entry) : select(entry, event)} onLongPress={() => { setMulti(true); setSelected(rows => rows.includes(entry.path) ? rows : [...rows, entry.path]); }}
   {...contextProps(() => { setSelected([entry.path]); setDialog("actions"); })}
   style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [{ flexDirection: view === "icons" ? "column" : "row", alignItems: "center", gap: view === "icons" ? 8 : 9, paddingHorizontal: view === "icons" ? 6 : 10, paddingVertical: view === "icons" ? 10 : compact ? 11 : 6, margin: view === "icons" ? 4 : 1, width: view === "icons" ? 112 : undefined, height: view === "icons" ? 126 : compact ? 46 : 36, minHeight: view === "icons" ? 110 : 32, borderRadius: view === "icons" ? 10 : 5, opacity: entry.accessible ? 1 : .65, backgroundColor: active && view !== "icons" ? c.accent : pressed || hovered ? c.surface2 : view === "list" && index % 2 ? c.surface1 : "transparent" }]}>
   <View style={{ borderRadius: 8, padding: view === "icons" ? 4 : 0, backgroundColor: active && view === "icons" ? c.surface2 : "transparent", minWidth: view === "icons" ? 70 : 26, alignItems: "center" }}><FileIcon entry={entry} size={icon} /></View>
   <Text numberOfLines={view === "icons" ? 2 : 1} style={[s.text, { flex: view === "icons" ? undefined : 1, paddingHorizontal: view === "icons" ? 5 : 0, paddingVertical: view === "icons" ? 2 : 0, borderRadius: 4, textAlign: view === "icons" ? "center" : "left", color: active ? c.accentForeground : c.foreground, backgroundColor: active && view === "icons" ? c.accent : "transparent", fontSize: 12, lineHeight: view === "icons" ? 16 : 19 }]}>{entry.name}</Text>
   {entry.favorite && view !== "icons" && <Icon name="Star" size={12} color={active ? c.accentForeground : c.foregroundMuted} />}
   {view === "list" && !compact && <><Text numberOfLines={1} style={[s.muted, { width: 132, color: active ? c.accentForeground : c.foregroundMuted }]}>{date(entry.modifiedAt)}</Text><Text style={[s.muted, { width: 90, textAlign: "right", color: active ? c.accentForeground : c.foregroundMuted }]}>{entry.kind === "folder" ? "—" : formatBytes(entry.size)}</Text><Text numberOfLines={1} style={[s.muted, { width: 100, color: active ? c.accentForeground : c.foregroundMuted }]}>{kind(entry)}</Text></>}
   {view === "columns" && entry.kind === "folder" && <Icon name="ChevronRight" size={13} color={active ? c.accentForeground : c.foregroundMuted} />}
  </Pressable>;
 }
 function previewContent(large = false): ReactNode {
  return <View style={{ flex: 1, minHeight: large ? 220 : 160, alignItems: "center", justifyContent: "center", padding: 18, gap: 16 }}>
   {!item ? <><Icon name="PanelRight" size={36} color={c.foregroundMuted} /><Text style={s.muted}>{selected.length > 1 ? `${selected.length}개 항목 선택` : "항목을 선택하면 미리보기가 표시됩니다."}</Text></> : previewQuery.isFetching && item.kind !== "folder" ? <Text style={s.muted}>미리보기 불러오는 중…</Text> : previewQuery.data?.dataUrl && failedImage !== item.path + item.modifiedAt ? <Image accessibilityLabel={item.name} source={{ uri: previewQuery.data.dataUrl }} onError={() => setFailedImage(item.path + item.modifiedAt)} resizeMode="contain" style={{ width: "100%", height: large ? 330 : 200 }} /> : previewQuery.data?.pages?.length ? <ScrollView style={{ width: "100%", maxHeight: large ? 460 : 300 }}>{previewQuery.data.pages.map((uri, index) => <Image key={index} accessibilityLabel={`PDF ${index + 1}페이지`} source={{ uri }} resizeMode="contain" style={{ width: "100%", height: large ? 420 : 260, marginBottom: 12 }} />)}</ScrollView> : previewQuery.data?.url ? <MediaPreview key={previewQuery.data.url} kind={previewQuery.data.kind} url={previewQuery.data.url} foreground={c.foreground} background={c.surface0} height={large ? 360 : 240} /> : previewQuery.data?.text !== null && previewQuery.data?.text !== undefined ? <ScrollView style={{ width: "100%", flex: 1, maxHeight: large ? 380 : 260 }}><Text selectable style={[s.text, { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11, lineHeight: 18 }]}>{previewQuery.data.text}</Text></ScrollView> : <><FileIcon entry={item} size={large ? 96 : 72} /><Text style={s.muted}>{previewQuery.error ? (previewQuery.error as Error).message : previewQuery.data?.message || (item.kind === "folder" ? "폴더를 열어 내용을 확인하세요." : "미리보기를 지원하지 않는 형식입니다.")}</Text></>}
   {item && <><Text numberOfLines={2} selectable style={[s.text, { textAlign: "center", fontSize: 15, fontWeight: "600" }]}>{item.name}</Text><Text style={s.muted}>{kind(item)}{item.kind !== "folder" ? ` · ${formatBytes(item.size)}` : ""}</Text>{previewQuery.data?.message && (previewQuery.data.text !== null || !!previewQuery.data.pages.length) && <Text style={s.muted}>{previewQuery.data.message}</Text>}</>}
   {item && item.kind !== "folder" && <View style={[s.row, { flexWrap: "wrap", justifyContent: "center" }]}>{previewQuery.data?.url && button("브라우저에서 미리보기", "ExternalLink", () => { void external(previewQuery.data!.url!); })}{previewQuery.error && button("미리보기 다시 불러오기", "RefreshCw", () => { void previewQuery.refetch(); }, previewQuery.isFetching)}{compact && inspector && button("다운로드", "Download", startDownload, busy, false, true)}</View>}
  </View>;
 }
 const title = trash ? "휴지통" : location.split("/").at(-1) || query.data?.home.split("/").at(-1) || "홈";
 return <View style={s.screen}>
  <View style={s.chrome}>
   <View style={[s.row, { gap: compact ? 2 : 5 }]}>
    {button("사이드바 표시", "PanelLeft", () => setSidebar(value => !value), false, sidebar)}
    {button("뒤로", "ChevronLeft", () => travel(-1), historyIndex.current === 0)}
    {!compact && button("앞으로", "ChevronRight", () => travel(1), historyIndex.current >= history.current.length - 1)}
    <View style={[s.row, { flex: 1, minWidth: 0, marginHorizontal: compact ? 6 : 10 }]}>{!compact && <Icon name={trash ? "Trash2" : "Folder"} size={18} color={c.foregroundMuted} />}<Text numberOfLines={1} style={[s.text, { flex: 1, fontSize: 16, fontWeight: "600", letterSpacing: -.2 }]}>{title}</Text></View>
    {!compact && <View style={[s.row, { gap: 0, backgroundColor: c.surface2, borderRadius: 8, padding: 2 }]}>{modes.map(option => button(option.label, option.icon, () => setMode(option.value), false, mode === option.value))}</View>}
    {!compact && selected.length > 0 && button(trash ? "복원" : "다운로드", trash ? "Undo2" : "Download", () => trash ? void perform({ action: "restore", paths: selected }) : startDownload(), busy || !picked.length || !trash && picked.some(row => row.kind === "folder" || !row.accessible))}
    {button("작업 메뉴", "Ellipsis", () => begin("actions"), busy)}
    {!compact && button("정보 및 미리보기", "PanelRight", () => setInspector(value => !value), false, inspector)}
    {button("검색", "Search", () => { setSearching(value => !value); if (searching) setSearch(""); }, false, searching)}
   </View>
   {(searching || !!search) && <View style={[s.row, { backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10 }]}><Icon name="Search" size={15} color={c.foregroundMuted} /><TextInput accessibilityLabel="현재 폴더에서 검색" autoFocus value={search} onChangeText={setSearch} placeholder="현재 폴더에서 검색" placeholderTextColor={c.foregroundMuted} style={[s.text, { flex: 1, minWidth: 0, paddingVertical: 9 }]} />{button("검색 닫기", "X", () => { setSearch(""); setSearching(false); })}</View>}
  </View>
  {notice && !dialog && <View style={[s.row, { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: c.surface2 }]}><Text accessibilityRole="alert" style={[s.text, { flex: 1 }]}>{notice}</Text>{button("알림 닫기", "X", () => setNotice(null))}</View>}
  <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
   {sidebar && <View style={{ width: compact ? 172 : 204, backgroundColor: c.surface1, borderRightWidth: 1, borderColor: c.border }}><ScrollView contentContainerStyle={{ padding: 10, gap: 3 }}>
    <Text style={[s.muted, { fontWeight: "600", marginHorizontal: 10, marginTop: 8, marginBottom: 6 }]}>즐겨찾기</Text>
    {query.data?.shortcuts.map(row => sideRow(row.name, row.path === "" ? "House" : row.path === "Downloads" ? "Download" : row.path === "Desktop" ? "Monitor" : row.path === "Pictures" ? "Image" : row.path === "Music" ? "Music2" : row.path === "Videos" ? "Film" : "FileText", row.path))}
    {query.data?.favorites.filter(row => !query.data?.shortcuts.some(shortcut => shortcut.path === row.path)).map(row => sideRow(row.name, row.kind === "folder" ? "Folder" : "File", row.path, false, true, row.kind !== "folder"))}
    <View style={s.line} /><Text style={[s.muted, { fontWeight: "600", marginHorizontal: 10, marginBottom: 6 }]}>위치</Text>
    {sideRow("휴지통", "Trash2", "", true)}

   </ScrollView></View>}
   <View style={{ flex: 1, minWidth: 0, minHeight: 0 }} onLayout={event => setContentWidth(event.nativeEvent.layout.width)}>
    {query.isLoading ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}><ActivityIndicator color={c.foregroundMuted} accessibilityLabel="폴더 불러오는 중" /><Text style={s.muted}>폴더 불러오는 중…</Text></View> : query.error ? <View style={{ padding: 24, gap: 14 }}><Icon name="FolderX" size={40} color={c.foregroundMuted} /><Text style={s.text}>{(query.error as Error).message}</Text>{button("다시 불러오기", "RefreshCw", () => { void query.refetch(); }, false, false, true)}{button("홈으로 이동", "House", () => navigate(""), false, false, true)}</View> : !entries.length ? <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 12 }}><Icon name={search ? "Search" : trash ? "Trash2" : "FolderOpen"} size={46} color={c.foregroundMuted} /><Text style={[s.text, { fontSize: 15 }]}>{search ? "일치하는 항목이 없습니다" : trash ? "휴지통이 비어 있습니다" : "이 폴더는 비어 있습니다"}</Text><Text style={s.muted}>{search ? "다른 이름으로 검색하거나 검색을 지우세요." : trash ? "삭제한 항목은 이곳에서 복원할 수 있습니다." : "새 폴더를 만들거나 항목을 붙여넣으세요."}</Text>{!trash && !search && button("새 폴더 만들기", "FolderPlus", () => begin("mkdir"), busy, false, true)}</View> : mode === "gallery" ? <View style={{ flex: 1 }}>{previewContent(true)}<ScrollView horizontal style={{ flexGrow: 0, maxHeight: 148, borderTopWidth: 1, borderColor: c.border }} contentContainerStyle={{ padding: 6 }}>{entries.map(row => fileItem(row, "icons"))}</ScrollView></View> : mode === "columns" && !trash ? <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>{ancestors.map((path, i) => <View key={path} style={{ width: 220, borderRightWidth: 1, borderColor: c.border }}><Text numberOfLines={1} style={[s.muted, { padding: 10, fontWeight: "600", backgroundColor: c.surface1 }]}>{path.split("/").at(-1) || "홈"}</Text><ScrollView contentContainerStyle={{ padding: 5 }}>{columnQueries[i]?.data?.entries.slice().sort((a, b) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || a.name.localeCompare(b.name, "ko", { numeric: true })).map(row => fileItem(row, "columns", true))}</ScrollView></View>)}<View style={{ width: compact ? 230 : 280, flexGrow: 1 }}><Text style={[s.muted, { padding: 10, fontWeight: "600", backgroundColor: c.surface1 }]}>{title}</Text><ScrollView contentContainerStyle={{ padding: 5 }}>{entries.map(row => fileItem(row, "columns"))}</ScrollView></View></ScrollView> : <View style={{ flex: 1 }}>
     {mode === "list" && <View style={[s.row, { paddingHorizontal: 16, paddingVertical: 7, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }]}><Text style={[s.muted, { flex: 1, fontWeight: "600" }]}>이름</Text>{!compact && <><Text style={[s.muted, { width: 132 }]}>수정한 날짜</Text><Text style={[s.muted, { width: 90, textAlign: "right" }]}>크기</Text><Text style={[s.muted, { width: 100, marginLeft: 9 }]}>종류</Text></>}</View>}
     <FlatList ref={fileListRef} key={`${mode}-${Math.max(1, Math.floor((contentWidth - (compact ? 12 : 32)) / 120))}`} data={entries} numColumns={mode === "icons" ? Math.max(1, Math.floor((contentWidth - (compact ? 12 : 32)) / 120)) : 1} keyExtractor={row => row.path} renderItem={({ item, index }) => fileItem(item, mode === "icons" ? "icons" : "list", false, index)} extraData={{ selected, multi }} initialNumToRender={40} windowSize={7} contentContainerStyle={mode === "icons" ? { padding: compact ? 6 : 16 } : { paddingHorizontal: 6, paddingVertical: 4 }} />
    </View>}
   </View>
   {inspector && !compact && <View style={{ width: 284, borderLeftWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }}><ScrollView contentContainerStyle={{ flexGrow: 1 }}><View style={[s.row, { paddingHorizontal: 12, paddingTop: 8 }]}><Text style={[s.muted, { flex: 1, fontWeight: "600" }]}>미리보기</Text>{button("정보 닫기", "X", () => setInspector(false))}</View>{mode !== "gallery" && previewContent()}<View style={{ padding: 16, gap: 12 }}>
    {item && <><Text style={s.muted}>수정한 날짜</Text><Text style={s.text}>{new Date(item.modifiedAt).toLocaleString("ko-KR")}</Text><Text style={s.muted}>{trash ? "원래 위치" : "위치"}</Text><Text selectable style={[s.text, { lineHeight: 18 }]}>{query.data?.home}/{item.originalPath || item.path}</Text></>}
   </View></ScrollView></View>}
  </View>
  <View style={[s.bottom, { flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: compact ? 2 : 12 }]} >
   <ScrollView horizontal style={{ flex: compact ? undefined : 1 }} showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>{button("홈 위치로 이동", "House", () => navigate(""))}{!trash && location.split("/").filter(Boolean).map((name, i, parts) => <View key={i} style={s.row}><Icon name="ChevronRight" size={13} color={c.foregroundMuted} /><Pressable accessibilityRole="button" accessibilityLabel={`${name} 폴더로 이동`} onPress={() => navigate(parts.slice(0, i + 1).join("/"))}><Text style={s.muted}>{name}</Text></Pressable></View>)}{trash && <Text style={s.muted}>휴지통</Text>}{button("폴더 경로 입력", "CornerDownRight", () => begin("goto"))}</ScrollView>
   <View style={[s.row, { justifyContent: "space-between" }]}><Text style={s.muted}>{selected.length ? `${selected.length}개 선택 · ` : ""}{entries.length.toLocaleString("ko-KR")}개 항목{query.data?.errors ? ` · ${query.data.errors}개 접근 불가` : ""}</Text>{compact && picked.length > 0 && button(trash ? "복원" : "다운로드", trash ? "Undo2" : "Download", () => trash ? void perform({ action: "restore", paths: selected }) : startDownload(), busy || !trash && picked.some(row => row.kind === "folder" || !row.accessible), false, true)}{compact && item && button("미리보기", "Eye", () => setInspector(true))}{clipboard && <Text style={s.muted}>{clipboard.paths.length}개 {clipboard.move ? "이동" : "복사"} 대기</Text>}</View>
  </View>
  <Modal title={dialog === "rename" ? "이름 변경" : dialog === "mkdir" ? "새 폴더" : dialog === "trash" ? "휴지통으로 이동" : dialog === "goto" ? "폴더로 이동" : dialog === "sort" ? "보기 옵션" : dialog === "download" ? "다운로드" : dialog === "url" ? "파일 URL 연결 설정" : "작업"} open={dialog !== null} onOpenChange={open => { if (!open && !busy) setDialog(null); }}><Modal.Content contentContainerStyle={{ padding: 22, gap: 14 }}>
   {(dialog === "rename" || dialog === "mkdir" || dialog === "goto") && <><Text style={s.muted}>{dialog === "goto" ? `홈 기준 상대 경로 또는 ${query.data?.home} 내부의 절대 경로` : dialog === "rename" ? "다른 항목과 같은 이름을 사용할 수 없습니다." : "현재 위치에 새 폴더를 만듭니다."}</Text><TextInput accessibilityLabel={dialog === "goto" ? "폴더 경로" : "이름"} autoFocus selectTextOnFocus value={input} onChangeText={setInput} style={s.input} onSubmitEditing={() => { if (dialog === "goto") { navigate(input.startsWith(query.data?.home + "/") ? input.slice((query.data?.home.length || 0) + 1) : input); setDialog(null); } else if (dialog === "rename" && item) void perform({ action: "rename", path: item.path, name: input }); else if (dialog === "mkdir") void perform({ action: "mkdir", path: location, name: input }); }} />{button(dialog === "goto" ? "이동" : "저장", "Check", () => { if (dialog === "goto") { navigate(input); setDialog(null); } else if (dialog === "rename" && item) void perform({ action: "rename", path: item.path, name: input }); else if (dialog === "mkdir") void perform({ action: "mkdir", path: location, name: input }); }, busy || !input.trim(), false, true)}</>}
   {dialog === "trash" && <><Icon name="Trash2" size={34} color={c.foregroundMuted} /><Text style={[s.text, { lineHeight: 21 }]}>{picked.length === 1 ? `‘${picked[0].name}’을` : `${picked.length}개 항목을`} 휴지통으로 이동할까요? 휴지통에서 원래 위치로 복원할 수 있습니다.</Text>{button("휴지통으로 이동", "Trash2", () => { void perform({ action: "trash", paths: selected, confirmed: true }); }, busy || !selected.length, false, true)}{button("취소", "X", () => setDialog(null), busy, false, true)}</>}
   {dialog === "sort" && <><Text style={[s.text, { fontWeight: "600" }]}>정렬 기준</Text>{([["name", "이름"], ["date", "수정한 날짜"], ["size", "크기"], ["kind", "종류"]] as const).map(([value, label]) => button(label, sort === value ? "Check" : "ArrowUpDown", () => setSort(value), false, sort === value, true))}{button(descending ? "내림차순" : "오름차순", descending ? "ArrowDown" : "ArrowUp", () => setDescending(value => !value), false, false, true)}<View style={s.line} />{button(hidden ? "숨김 항목 숨기기" : "숨김 항목 표시", hidden ? "EyeOff" : "Eye", () => setHidden(value => !value), false, hidden, true)}<Text style={s.muted}>Ctrl/⌘ + Shift + .</Text><View style={s.line} />{button("다운로드 연결 설정", "Link", () => { void urlOptions(); }, busy, false, true)}</>}
   {dialog === "actions" && <>
    {compact && <View style={[s.row, { justifyContent: "space-between", backgroundColor: c.surface2, borderRadius: 8, padding: 3 }]}>{modes.map(option => button(option.label, option.icon, () => { setMode(option.value); setDialog(null); }, false, mode === option.value))}</View>}
    <Text numberOfLines={2} style={[s.text, { fontWeight: "600" }]}>{item?.name || (selected.length ? `${selected.length}개 항목 선택` : title)}</Text>
    {!trash && selected.length > 0 && <>{item && button("열기 / 미리보기", "FolderOpen", () => { setDialog(null); if (item) open(item); }, !item, false, true)}{item && button("이름 변경", "Pencil", () => begin("rename"), busy || !item, false, true)}{item && button(item?.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가", "Star", () => { if (item) void perform({ action: "favorite", path: item.path, enabled: !item.favorite }); }, busy || !item, false, true)}{button("다운로드", "Download", () => { startDownload(); }, busy || picked.some(row => row.kind === "folder"), false, true)}{item && item.kind !== "folder" && downloadQuery.data && Date.parse(downloadQuery.data.expiresAt) > Date.now() && button("다운로드 링크 복사", "Link", () => { void copyLink(downloadQuery.data!.url); }, busy, false, true)}<View style={s.line} />{button("복사", "Copy", () => { setClipboard({ paths: selected, move: false }); setDialog(null); toast.show("대상 폴더로 이동하여 붙여넣으세요."); }, busy, false, true)}{button("잘라내기", "Scissors", () => { setClipboard({ paths: selected, move: true }); setDialog(null); }, busy, false, true)}{clipboard && button("이 폴더에 붙여넣기", "ClipboardPaste", () => { void perform({ action: "copy", paths: clipboard.paths, destination: location, move: clipboard.move }); }, busy, false, true)}<View style={s.line} />{button("휴지통으로 이동", "Trash2", () => begin("trash"), busy, false, true)}</>}
    {trash && selected.length > 0 && button("원래 위치로 복원", "Undo2", () => { void perform({ action: "restore", paths: selected }); }, busy, false, true)}
    <View style={s.line} />
    {!trash && button("새 폴더", "FolderPlus", () => begin("mkdir"), busy, false, true)}
    {button(multi ? "다중 선택 마치기" : "다중 선택", "ListChecks", () => { setMulti(value => !value); setDialog(null); }, false, multi, true)}
    {button("전체 선택", "SquareCheckBig", () => { setSelected(entries.map(row => row.path)); setDialog(null); }, !entries.length, false, true)}
    {selected.length > 0 && button("선택 해제", "Square", () => { setSelected([]); setMulti(false); setDialog(null); }, false, false, true)}
    {clipboard && !trash && !selected.length && button("붙여넣기", "ClipboardPaste", () => { void perform({ action: "copy", paths: clipboard.paths, destination: location, move: clipboard.move }); }, busy, false, true)}
    {!trash && button(query.data?.favorites.some(row => row.path === location) ? "현재 폴더 즐겨찾기 해제" : "현재 폴더 즐겨찾기", "Star", () => { void perform({ action: "favorite", path: location, enabled: !query.data?.favorites.some(row => row.path === location) }); }, busy, false, true)}
    <View style={s.line} />{button("보기 옵션", "ArrowDownWideNarrow", () => begin("sort"), false, false, true)}
    {button("상위 폴더", "ChevronUp", () => { navigate(parent(location)); setDialog(null); }, !location || trash, false, true)}
    {compact && button("앞으로", "ChevronRight", () => { travel(1); setDialog(null); }, historyIndex.current >= history.current.length - 1, false, true)}
    {button("폴더로 이동", "CornerDownRight", () => begin("goto"), false, false, true)}
    {button("새로고침", "RefreshCw", () => { void query.refetch(); if (item && inspector) void previewQuery.refetch(); setDialog(null); }, query.isFetching, false, true)}
   </>}
   {dialog === "download" && <>
    {downloadLinks.map(entry => <View key={entry.path} style={[s.row, { justifyContent: "space-between", gap: 12 }]}><View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={2} style={[s.text, { fontWeight: "600" }]}>{entry.name}</Text></View>{button("링크 복사 · " + entry.name, "Link", () => { void copyLink(entry.url); }, busy)}{button("다운로드", "Download", () => { if (Date.parse(entry.expiresAt) <= Date.now()) void prepareDownload(); else void external(entry.url); }, busy, false, true, true)}</View>)}
    {busy && <ActivityIndicator accessibilityLabel="다운로드 준비 중" color={c.accent} />}
    {!!downloadLinks.length && <Text style={s.muted}>이 기기의 브라우저에서 다운로드합니다.</Text>}
    {!busy && !downloadLinks.length && button("다시 시도", "RefreshCw", () => { void prepareDownload(); }, false, false, true)}
    {notice && button("다운로드 연결 설정", "Settings2", () => { void urlOptions(); }, busy, false, true)}
   </>}
   {dialog === "url" && <><Text style={[s.muted, { lineHeight: 21 }]}>비워두면 호스트의 VPN·내부망 주소를 사용합니다. 원격 연결에서 열리지 않으면 이 기기에서 접근 가능한 HTTPS 파일 서버 주소를 입력하세요. 이 주소는 파일 URL 서버로 연결되어야 합니다.</Text><TextInput accessibilityLabel="파일 URL 서버 주소" value={input} onChangeText={setInput} placeholder="자동 주소 사용" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={s.input} />{button("주소 저장", "Check", () => { void saveUrl(); }, busy, false, true)}</>}
   {busy && dialog !== "download" && <Text style={s.muted}>작업 중…</Text>}{notice && <Text accessibilityRole="alert" style={s.text}>{notice}</Text>}
  </Modal.Content></Modal>
  <Modal title="미리보기" open={compact && inspector} onOpenChange={setInspector}><Modal.Content>{previewContent(true)}</Modal.Content></Modal>
 </View>;
}
