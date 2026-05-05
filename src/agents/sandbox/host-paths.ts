import { posix } from "node:path";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";

function stripWindowsNamespacePrefix(input: string): string {
  if (input.startsWith("\\\\?\\")) {
    const withoutPrefix = input.slice(4);
    if (withoutPrefix.toUpperCase().startsWith("UNC\\")) {
      return `\\\\${withoutPrefix.slice(4)}`;
    }
    return withoutPrefix;
  }
  if (input.startsWith("//?/")) {
    const withoutPrefix = input.slice(4);
    if (withoutPrefix.toUpperCase().startsWith("UNC/")) {
      return `//${withoutPrefix.slice(4)}`;
    }
    return withoutPrefix;
  }
  return input;
}

export function isWindowsDriveAbsolutePath(raw: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(stripWindowsNamespacePrefix(raw.trim()));
}

export function isSandboxHostPathAbsolute(raw: string): boolean {
  const trimmed = stripWindowsNamespacePrefix(raw.trim());
  return trimmed.startsWith("/") || isWindowsDriveAbsolutePath(trimmed);
}

/**
 * Normalize a host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
 * Windows drive-letter paths preserve the drive root and uppercase the drive letter.
 */
export function normalizeSandboxHostPath(raw: string): string {
  const trimmed = stripWindowsNamespacePrefix(raw.trim());
  if (!trimmed) {
    return "/";
  }
  let normalTrimmed = trimmed.replaceAll("\\", "/");
  if (isWindowsDriveAbsolutePath(normalTrimmed)) {
    normalTrimmed = normalTrimmed.charAt(0).toUpperCase() + normalTrimmed.slice(1);
  }
  const normalized = posix.normalize(normalTrimmed);
  const withoutTrailingSlash = normalized.replace(/\/+$/, "") || "/";
  if (/^[A-Z]:$/.test(withoutTrailingSlash)) {
    return `${withoutTrailingSlash}/`;
  }
  return withoutTrailingSlash;
}

export function getSandboxHostPathPolicyKey(raw: string): string {
  const normalized = normalizeSandboxHostPath(raw);
  if (isWindowsDriveAbsolutePath(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Resolve a path through the deepest existing ancestor so parent symlinks are honored
 * even when the final source leaf does not exist yet.
 */
export function resolveSandboxHostPathViaExistingAncestor(sourcePath: string): string {
  if (!isSandboxHostPathAbsolute(sourcePath)) {
    return sourcePath;
  }
  if (isWindowsDriveAbsolutePath(sourcePath) && process.platform !== "win32") {
    return normalizeSandboxHostPath(sourcePath);
  }
  return normalizeSandboxHostPath(resolvePathViaExistingAncestorSync(sourcePath));
}
