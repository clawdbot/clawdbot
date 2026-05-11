/**
 * @deprecated Broad public SDK barrel. Prefer focused security/SSRF/secret
 * subpaths and avoid adding new imports here.
 */

import { root as fsRoot, type OpenResult } from "../infra/fs-safe.js";

export * from "../secrets/channel-secret-collector-runtime.js";
export * from "../secrets/runtime-shared.js";
export * from "../secrets/shared.js";
export type * from "../secrets/target-registry-types.js";
export * from "../security/channel-metadata.js";
export * from "../security/context-visibility.js";
export * from "./channel-access-compat.js";
export {
  ACCESS_GROUP_ALLOW_FROM_PREFIX,
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
  resolveAccessGroupAllowFromMatches,
  resolveAccessGroupAllowFromState,
  type AccessGroupMembershipResolver,
  type AccessGroupMembershipLookup,
  type ResolvedAccessGroupAllowFromState,
} from "./access-groups.js";
export * from "../security/external-content.js";
export * from "../security/safe-regex.js";
export {
  appendRegularFile,
  appendRegularFileSync,
  FsSafeError,
  FsSafeError as SafeOpenError,
  openLocalFileSafely,
  pathExists,
  pathExistsSync,
  readRegularFile,
  resolveLocalPathFromRootsSync,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  root,
  statRegularFileSync,
  writeExternalFileWithinRoot,
  withTimeout,
  type ExternalFileWriteOptions,
  type ExternalFileWriteResult,
  type FsSafeErrorCode as SafeOpenErrorCode,
} from "../infra/fs-safe.js";

export async function openFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
  nonBlockingRead?: boolean;
  allowSymlinkTargetWithinRoot?: boolean;
}): Promise<OpenResult> {
  const root = await fsRoot(params.rootDir);
  return await root.open(params.relativePath, {
    hardlinks: params.rejectHardlinks === false ? "allow" : "reject",
    nonBlockingRead: params.nonBlockingRead,
    symlinks: params.allowSymlinkTargetWithinRoot === true ? "follow-within-root" : "reject",
  });
}

export async function writeFileFromPathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  sourcePath: string;
  mkdir?: boolean;
}): Promise<void> {
  const root = await fsRoot(params.rootDir);
  await root.copyIn(params.relativePath, params.sourcePath, {
    mkdir: params.mkdir,
    sourceHardlinks: "reject",
  });
}

export { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
export { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
export { normalizeHostname } from "../infra/net/hostname.js";
export {
  SsrFBlockedError,
  isBlockedHostnameOrIp,
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
export { isNotFoundPathError, isPathInside } from "../infra/path-guards.js";
export {
  assertAbsolutePathInput,
  canonicalPathFromExistingAncestor,
  ensureAbsoluteDirectory,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
  type AbsolutePathSymlinkPolicy,
  type EnsureAbsoluteDirectoryOptions,
  type EnsureAbsoluteDirectoryResult,
  type ResolvedAbsolutePath,
  type ResolvedWritableAbsolutePath,
} from "../infra/fs-safe.js";
export { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
export {
  privateFileStore,
  privateFileStoreSync,
  type PrivateFileStore,
} from "../infra/private-file-store.js";
export {
  movePathWithCopyFallback,
  replaceFileAtomic,
  replaceFileAtomicSync,
  type MovePathWithCopyFallbackOptions,
  type ReplaceFileAtomicFileSystem,
  type ReplaceFileAtomicOptions,
  type ReplaceFileAtomicResult,
  type ReplaceFileAtomicSyncFileSystem,
  type ReplaceFileAtomicSyncOptions,
} from "../infra/replace-file.js";
export {
  writeSiblingTempFile,
  type WriteSiblingTempFileOptions,
  type WriteSiblingTempFileResult,
} from "../infra/sibling-temp-file.js";
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  type AssertNoSymlinkParentsOptions,
} from "../infra/fs-safe-advanced.js";
export { ensurePortAvailable } from "../infra/ports.js";
export { generateSecureToken } from "../infra/secure-random.js";
export {
  resolveExistingPathsWithinRoot,
  pathScope,
  resolvePathsWithinRoot,
  resolvePathWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
} from "../infra/root-paths.js";
export { writeViaSiblingTempPath } from "../infra/fs-safe-advanced.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { redactSensitiveText } from "../logging/redact.js";
export { safeEqualSecret } from "../security/secret-equal.js";
