// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";
import path from "node:path";

// Advanced fs-safe helpers for symlink, hardlink, and sibling-temp protections.
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  type FileIdentityStat,
  sameFileIdentity,
} from "@openclaw/fs-safe/advanced";
export { readSecretFile } from "@openclaw/fs-safe/secret";

/** Preserve the shipped Plugin SDK filename contract while fs-safe owns path basename handling. */
export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";
  if (!trimmed) {
    return fallbackName;
  }
  let base = path.win32.basename(path.posix.basename(trimmed));
  let cleaned = "";
  for (let index = 0; index < base.length; index += 1) {
    const code = base.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    cleaned += base[index];
  }
  base = cleaned.trim();
  if (!base || base === "." || base === "..") {
    return fallbackName;
  }
  return base.length > 200 ? base.slice(0, 200) : base;
}
