import { DEFAULT_VIDEO_MAX_BASE64_BYTES } from "./defaults.js";

export function estimateBase64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export function resolveVideoMaxBase64Bytes(maxBytes: number): number {
  const expanded = Math.floor(maxBytes * (4 / 3));
  return Math.min(expanded, DEFAULT_VIDEO_MAX_BASE64_BYTES);
}
