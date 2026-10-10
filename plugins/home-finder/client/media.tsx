import { Component, useEffect, useMemo, useState, type ReactNode, type ComponentType } from "react";
import { Platform, View, Text, requireNativeComponent, UIManager, type ViewProps } from "react-native";
import { browserMedia } from "./web";
export function mediaHtml(kind: string, url: string, foreground: string, background: string) {
 const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
 const safe = new URL(url); if (!/^https?:$/.test(safe.protocol)) throw new Error("미리보기 주소가 올바르지 않습니다.");
 const element = kind === "image" ? `<img src="${escape(url)}" alt="파일 미리보기">` : kind === "pdf" ? `<iframe title="PDF 문서" src="${escape(url)}"></iframe>` : `<${kind === "audio" ? "audio" : "video"} controls playsinline preload="metadata" src="${escape(url)}"></${kind === "audio" ? "audio" : "video"}>`;
 // Only this fixed viewer executes. User HTML/SVG documents are never inserted into it.
 return `<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data:; media-src http: https:; frame-src http: https:; style-src 'unsafe-inline'; script-src 'nonce-finder-viewer'"><style>html,body{height:100%;margin:0;color:${escape(foreground)};background:${escape(background)};font:14px system-ui}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}img,video{width:100%;height:100%;object-fit:contain}audio{width:95%}iframe{width:100%;height:100%;border:0}p{line-height:1.5;padding:12px}p:empty{display:none}</style></head><body>${element}<p role="alert" id="status"></p><script nonce="finder-viewer">const media=document.querySelector('video,audio,img');if(media){let timer=setTimeout(()=>show('파일 서버에 연결하지 못했습니다. 같은 VPN·네트워크 연결을 확인하거나 브라우저에서 열어주세요.'),20000);function show(text){document.getElementById('status').textContent=text;}media.addEventListener('error',()=>{clearTimeout(timer);show('이 기기에서 지원하지 않는 형식이거나 파일 URL에 연결할 수 없습니다. 브라우저 열기 또는 다운로드를 이용하세요.');});media.addEventListener(media.tagName==='IMG'?'load':'loadedmetadata',()=>{clearTimeout(timer);show('');});}</script></body></html>`;
}
interface NativeProps extends ViewProps { newSource: { html: string; baseUrl: string }; javaScriptEnabled: boolean; messagingEnabled: boolean; allowsInlineMediaPlayback: boolean; mediaPlaybackRequiresUserAction: boolean; mixedContentMode: string; allowFileAccess: boolean; onLoadingError: () => void; onHttpError: () => void; }
let NativeViewer: ComponentType<NativeProps> | null | undefined;
function nativeViewer() {
 if (NativeViewer !== undefined) return NativeViewer;
 try { NativeViewer = UIManager.getViewManagerConfig("RNCWebView") ? requireNativeComponent<NativeProps>("RNCWebView") : null; } catch { NativeViewer = null; }
 return NativeViewer;
}
class ViewerBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
 state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; }
 render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
export function MediaPreview({ kind, url, foreground, background, height }: { kind: string; url: string; foreground: string; background: string; height: number }) {
 const [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(false);
 useEffect(() => { if (Platform.OS !== "web" || loaded) return; const timer = setTimeout(() => setFailed(true), 20000); return () => clearTimeout(timer); }, [loaded]);
 const html = useMemo(() => mediaHtml(kind, url, foreground, background), [kind, url, foreground, background]);
 const fallback = <Text accessibilityRole="alert" style={{ color: foreground, fontSize: 13, lineHeight: 21 }}>파일 URL에 연결할 수 없거나 이 기기가 형식을 지원하지 않습니다. 아래 ‘브라우저에서 미리보기’를 이용하세요.</Text>;
 if (failed) return fallback;
 if (Platform.OS === "web") return browserMedia(kind, url, height, () => setFailed(true), () => setLoaded(true));
 const Viewer = nativeViewer(); if (!Viewer) return fallback;
 return <ViewerBoundary fallback={fallback}><View style={{ width: "100%", height }}><Viewer newSource={{ html, baseUrl: new URL(url).origin }} javaScriptEnabled messagingEnabled={false} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction mixedContentMode="always" allowFileAccess={false} onLoadingError={() => setFailed(true)} onHttpError={() => setFailed(true)} style={{ flex: 1, backgroundColor: background }} /></View></ViewerBoundary>;
}
