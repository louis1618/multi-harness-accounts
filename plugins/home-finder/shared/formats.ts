export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "office" | "archive" | "binary";
const groups: [PreviewKind, string, string][] = [
 ["image","png","image/png"],["image","jpg jpeg jpe","image/jpeg"],["image","gif","image/gif"],["image","webp","image/webp"],["image","avif","image/avif"],["image","bmp","image/bmp"],["image","tif tiff","image/tiff"],["image","svg","image/svg+xml"],["image","ico","image/x-icon"],["image","heic heif","image/heic"],
 ["video","mp4 m4v","video/mp4"],["video","mov qt","video/quicktime"],["video","webm","video/webm"],["video","ogv","video/ogg"],["video","mkv","video/x-matroska"],["video","avi","video/x-msvideo"],["video","mpg mpeg","video/mpeg"],["video","wmv","video/x-ms-wmv"],["video","flv","video/x-flv"],["video","3gp","video/3gpp"],
 ["audio","mp3","audio/mpeg"],["audio","m4a","audio/mp4"],["audio","aac","audio/aac"],["audio","wav","audio/wav"],["audio","flac","audio/flac"],["audio","ogg oga opus","audio/ogg"],["audio","aif aiff","audio/aiff"],
 ["pdf","pdf","application/pdf"],["office","docx xlsx pptx odt ods odp epub","application/octet-stream"],
 ["archive","zip tar gz tgz bz2 xz 7z rar","application/octet-stream"],
 ["text","txt md markdown json jsonl yaml yml toml ini conf cfg csv tsv log xml html htm css scss sass js jsx ts tsx mjs cjs py rb go rs c cpp h hpp java kt swift sh bash zsh sql vue svelte ipynb rtf tex env gitignore dockerfile makefile","text/plain"],
];
export function fileFormat(name: string): {kind: PreviewKind; mime: string} {
 const extension=name.toLowerCase().split(".").at(-1) || "";
 for(const [kind, extensions, mime] of groups) if(extensions.split(" ").includes(extension)) return {kind,mime};
 return {kind:"binary",mime:"application/octet-stream"};
}
