import { saveMediaBuffer } from "../media/store.js";

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

export async function persistBrowserProxyFiles(files: BrowserProxyFile[] | undefined) {
  if (!files || files.length === 0) {
    return new Map<string, string>();
  }
  const mapping = new Map<string, string>();
  for (const file of files) {
    const buffer = Buffer.from(file.base64, "base64");
    const saved = await saveMediaBuffer(buffer, file.mimeType, "browser");
    mapping.set(file.path, saved.path);
  }
  return mapping;
}

export function applyBrowserProxyPaths(result: unknown, mapping: Map<string, string>) {
  if (!result || typeof result !== "object") {
    return;
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.path === "string" && mapping.has(obj.path)) {
    obj.path = mapping.get(obj.path);
  }
  if (typeof obj.imagePath === "string" && mapping.has(obj.imagePath)) {
    obj.imagePath = mapping.get(obj.imagePath);
  }
  const download = obj.download;
  if (download && typeof download === "object") {
    const d = download as Record<string, unknown>;
    if (typeof d.path === "string" && mapping.has(d.path)) {
      d.path = mapping.get(d.path);
    }
  }
}
