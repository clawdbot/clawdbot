/**
 * Session tool path normalization helpers.
 *
 * Expands user/file URL inputs and resolves read/write paths against the active cwd with macOS filename variants.
 */
import * as os from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (?=(?:AM|PM)(?:\b|\.))/gi, NARROW_NO_BREAK_SPACE);
}

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string, normalizeSpaces = true): string {
  const withoutAtPrefix = normalizeAtPrefix(filePath);
  const normalized = normalizeSpaces ? normalizeUnicodeSpaces(withoutAtPrefix) : withoutAtPrefix;
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(cwd, expanded);
}

export function resolveReadPath(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath, false);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

/** Equivalent spellings worth probing after an exact read path misses. */
export function getReadPathVariants(filePath: string): string[] {
  const variants = new Set<string>();
  const asciiSpace = normalizeUnicodeSpaces(filePath);
  for (const spaced of [asciiSpace, tryMacOSScreenshotPath(asciiSpace)]) {
    const straightQuotes = spaced.replace(/[\u2018\u2019]/g, "'");
    const curlyQuotes = spaced.replace(/['\u2018]/g, "\u2019");
    for (const quoted of [straightQuotes, curlyQuotes]) {
      variants.add(quoted.normalize("NFC"));
      variants.add(quoted.normalize("NFD"));
    }
  }
  variants.delete(filePath);
  return [...variants];
}
