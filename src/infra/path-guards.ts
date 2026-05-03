import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set(["ELOOP", "EINVAL", "ENOTSUP"]);
const PARENT_SEGMENT_PREFIX = /^\.\.(?:[\\/]|$)/u;
const POSIX_SEPARATOR_CHAR_CODE = 0x2f;

export function normalizeWindowsPathForComparison(input: string): string {
  let normalized = path.win32.normalize(input);
  if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
    if (normalized.toUpperCase().startsWith("UNC\\")) {
      normalized = `\\\\${normalized.slice(4)}`;
    }
  }
  return normalizeLowercaseStringOrEmpty(normalized.replaceAll("/", "\\"));
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(
    value && typeof value === "object" && "code" in (value as Record<string, unknown>),
  );
}

export function hasNodeErrorCode(value: unknown, code: string): boolean {
  return isNodeError(value) && value.code === code;
}

export function isNotFoundPathError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}

export function isSymlinkOpenError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}

export function isPathInside(root: string, target: string): boolean {
  if (process.platform === "win32") {
    const rootForCompare = normalizeWindowsPathForComparison(path.win32.resolve(root));
    const targetForCompare = normalizeWindowsPathForComparison(path.win32.resolve(target));
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    return (
      relative === "" || (!PARENT_SEGMENT_PREFIX.test(relative) && !path.win32.isAbsolute(relative))
    );
  }

  if (
    root.length > 0 &&
    root.charCodeAt(0) === POSIX_SEPARATOR_CHAR_CODE &&
    target.length >= root.length &&
    target.charCodeAt(0) === POSIX_SEPARATOR_CHAR_CODE &&
    !target.includes("/..") &&
    (target === root ||
      (target.startsWith(root) && target.charCodeAt(root.length) === POSIX_SEPARATOR_CHAR_CODE))
  ) {
    return true;
  }

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!PARENT_SEGMENT_PREFIX.test(relative) && !path.isAbsolute(relative));
}
