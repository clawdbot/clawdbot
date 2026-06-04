import { DEFAULT_VIDEO_MAX_BASE64_BYTES } from "./defaults.js";

// Video payload size helpers for base64-expanded request bodies.

/** Estimate base64 size for a byte count. */
export function estimateBase64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Resolve video base64 byte limit from raw byte limit and global cap. */
export function resolveVideoMaxBase64Bytes(maxBytes: number): number {
  const expanded = Math.floor(maxBytes * (4 / 3));
  return Math.min(expanded, DEFAULT_VIDEO_MAX_BASE64_BYTES);
}
