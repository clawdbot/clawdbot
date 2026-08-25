/**
 * Session tool path normalization helpers.
 *
 * Expands user/file URL inputs and resolves read/write paths against the active cwd with macOS filename variants.
 */
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHomePrefix, resolveOsHomeDir } from "../../../infra/home-dir.js";

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

/** Expand OS-home syntax without treating a POSIX backslash as a separator. */
export function expandOsHomePrefix(filePath: string): string {
  const isHomePath =
    filePath === "~" ||
    filePath.startsWith("~/") ||
    (process.platform === "win32" && filePath.startsWith("~\\"));
  if (!isHomePath) {
    return filePath;
  }
  const home = resolveOsHomeDir();
  return home ? expandHomePrefix(filePath, { home }) : filePath;
}

function expandPath(filePath: string): string {
  const normalized = normalizeAtPrefix(filePath);
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  return expandOsHomePrefix(normalized);
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

/** Equivalent filename spellings worth probing after an exact read path misses. */
export function getReadPathVariants(filePath: string): string[] {
  const variants = new Set<string>();
  const fileName = basename(filePath);
  const parentPrefix = filePath.slice(0, filePath.length - fileName.length);
  // The caller may already have authorized the parent directory. Only vary the
  // basename so a fallback cannot escape that validated boundary.
  const asciiSpace = normalizeUnicodeSpaces(fileName);
  for (const spaced of [asciiSpace, tryMacOSScreenshotPath(asciiSpace)]) {
    const straightQuotes = spaced.replace(/[\u2018\u2019]/g, "'");
    const curlyQuotes = spaced.replace(/['\u2018]/g, "\u2019");
    for (const quoted of [straightQuotes, curlyQuotes]) {
      variants.add(`${parentPrefix}${quoted.normalize("NFC")}`);
      // macOS filesystems resolve NFC/NFD spellings to the same entry; probing both
      // makes one file look ambiguous. Other platforms can store both distinctly.
      if (process.platform !== "darwin") {
        variants.add(`${parentPrefix}${quoted.normalize("NFD")}`);
      }
    }
  }
  variants.delete(filePath);
  return [...variants];
}
