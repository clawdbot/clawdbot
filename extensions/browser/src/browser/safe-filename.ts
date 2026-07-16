import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  const trimmed = normalizeOptionalString(fileName) ?? "";
  if (!trimmed) {
    return fallbackName;
  }
  let base = path.posix.basename(trimmed);
  base = path.win32.basename(base);
  let cleaned = "";
  for (let i = 0; i < base.length; i++) {
    const code = base.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    cleaned += base[i];
  }
  base = cleaned.trim();
  if (!base || base === "." || base === "..") {
    return fallbackName;
  }
  if (base.length > 200) {
    base = base.slice(0, 200);
  }
  return base;
}
