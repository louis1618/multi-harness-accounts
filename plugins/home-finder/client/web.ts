import { createElement } from "react";
import { Platform } from "react-native";
declare const window: {
 addEventListener(name: string, handler: (event: KeyEvent) => void): void;
 removeEventListener(name: string, handler: (event: KeyEvent) => void): void;
};
interface KeyEvent { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target?: { tagName?: string; isContentEditable?: boolean }; preventDefault(): void; }
export function keyboard(handler: (event: KeyEvent) => boolean) {
 if (Platform.OS !== "web") return () => {};
 const listener = (event: KeyEvent) => { if (["INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO", "IFRAME"].includes(event.target?.tagName || "") || event.target?.isContentEditable) return; if (handler(event)) event.preventDefault(); };
 window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
}
export function modifiers(event: unknown) { const e = event as { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; nativeEvent?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } }; return { additive: !!(e.ctrlKey || e.metaKey || e.nativeEvent?.ctrlKey || e.nativeEvent?.metaKey), range: !!(e.shiftKey || e.nativeEvent?.shiftKey) }; }
export function contextProps(onMenu: () => void) { return Platform.OS === "web" ? { onContextMenu: (event: { preventDefault(): void; stopPropagation(): void }) => { event.preventDefault(); event.stopPropagation(); onMenu(); } } : {}; }
export function browserMedia(kind: string, url: string, height: number, onError: () => void, onReady: () => void = () => {}) {
 const style = { width: "100%", height, objectFit: "contain", border: 0, borderRadius: 6 };
 if (kind === "pdf") return createElement("iframe", { src: url, title: "PDF 문서", referrerPolicy: "no-referrer", style, onError, onLoad: onReady });
 if (kind === "image") return createElement("img", { src: url, alt: "파일 미리보기", referrerPolicy: "no-referrer", style, onError, onLoad: onReady });
 return createElement(kind === "audio" ? "audio" : "video", { src: url, controls: true, playsInline: true, preload: "metadata", style, onError, onLoadedMetadata: onReady, "aria-label": kind === "audio" ? "오디오 미리보기" : "동영상 미리보기" });
}
