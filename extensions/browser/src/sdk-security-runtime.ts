/**
 * Browser-local SDK security bridge plus directory creation helper.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  findExistingAncestor,
  pathScope as sdkPathScope,
} from "openclaw/plugin-sdk/security-runtime";

export {
  ensurePortAvailable,
  extractErrorCode,
  formatErrorMessage,
  hasProxyEnvConfigured,
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  normalizeHostname,
  resolveExistingPathsWithinRoot,
  resolvePinnedHostnameWithPolicy,
  sanitizeUntrustedFileName,
  resolveStrictExistingPathsWithinRoot,
  SsrFBlockedError,
  writeExternalFileWithinRoot,
  wrapExternalContent,
} from "openclaw/plugin-sdk/security-runtime";
export type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
export { sdkPathScope as pathScope };

/** Ensures an absolute directory exists without escaping its nearest existing ancestor. */
export async function ensureAbsoluteDirectory(
  dirPath: string,
  options?: { scopeLabel?: string; mode?: number },
): Promise<{ ok: true; path: string } | { ok: false; error: Error }> {
  const absolutePath = path.resolve(dirPath);
  const scopeLabel = options?.scopeLabel ?? "directory";
  const existingAncestor = await findExistingAncestor(absolutePath);
  if (!existingAncestor) {
    return { ok: false, error: new Error(`Invalid path: must stay within ${scopeLabel}`) };
  }
  if (existingAncestor === absolutePath) {
    try {
      const stat = await fs.lstat(absolutePath);
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        return { ok: true, path: absolutePath };
      }
    } catch {
      // Fall through to the uniform invalid-path result below.
    }
    return { ok: false, error: new Error(`Invalid path: must stay within ${scopeLabel}`) };
  }
  const result = await sdkPathScope(existingAncestor, {
    label: options?.scopeLabel ?? "directory",
  }).ensureDir(path.relative(existingAncestor, absolutePath), { mode: options?.mode });
  if (result.ok) {
    return result;
  }
  return { ok: false, error: new Error(result.error) };
}
