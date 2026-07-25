// Exposes generic path guard helpers with fs-safe defaults.
import path from "node:path";
import "./fs-safe-defaults.js";

// Generic path guard facade for containment checks and safe relative paths.
export {
  isNotFoundPathError,
  isPathInside,
  normalizeWindowsPathForComparison,
  safeStatSync,
} from "@openclaw/fs-safe/path";

/**
 * Normalize a Windows path for boundary math whose result is handed back to callers.
 *
 * Unlike `normalizeWindowsPathForComparison`, this preserves case: `path.win32.relative`
 * already matches roots case-insensitively, so lowercasing only corrupts the returned
 * relative path — and callers create files from it on a case-preserving filesystem.
 * Extended-length prefix stripping stays, or `\\?\`-prefixed inputs read as boundary escapes.
 */
export function normalizeWindowsPathPreservingCase(input: string): string {
  // Mirrors normalizeWindowsPathForComparison step for step, minus the lowercasing,
  // so the only behavior that shifts is the case of the characters handed back.
  const normalized = path.win32.normalize(input).trim();
  if (!normalized.startsWith("\\\\?\\")) {
    return normalized;
  }
  const withoutPrefix = normalized.slice(4);
  return withoutPrefix.toUpperCase().startsWith("UNC\\")
    ? `\\\\${withoutPrefix.slice(4)}`
    : withoutPrefix;
}
