// Normalizes executable tokens used by wrapper and policy analysis.
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".cmd", ".bat", ".com"] as const;

function stripWindowsExecutableSuffix(value: string): string {
  for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
    if (value.endsWith(suffix)) {
      return value.slice(0, -suffix.length);
    }
  }
  return value;
}

/** Return a lowercase basename using the shorter POSIX/Windows interpretation. */
function basenameLower(token: string): string {
  const win = path.win32.basename(token);
  const posix = path.posix.basename(token);
  const base = win.length < posix.length ? win : posix;
  return normalizeLowercaseStringOrEmpty(base);
}

/** Normalize an executable token for wrapper and policy matching. */
export function normalizeExecutableToken(token: string): string {
  return stripWindowsExecutableSuffix(basenameLower(token));
}
