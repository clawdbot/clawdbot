/**
 * @deprecated Broad public SDK barrel. Prefer focused security/SSRF/secret
 * subpaths and avoid adding new imports here.
 */

import { statRegularFileSync as inspectRegularFileSync } from "../infra/fs-safe.js";

/** Return whether a path resolves to a regular file, treating filesystem errors as missing. */
export function fileExists(filePath: string): boolean {
  try {
    return !inspectRegularFileSync(filePath).missing;
  } catch {
    return false;
  }
}

export { buildUntrustedChannelMetadata } from "../security/channel-metadata.js";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "../security/context-visibility.js";
export type { ContextVisibilityDecision } from "../security/context-visibility.js";

export {
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
} from "./access-groups.js";
export { wrapExternalContent, wrapWebContent } from "../security/external-content.js";
export { compileSafeRegexDetailed } from "../security/safe-regex.js";
export type { SafeRegexRejectReason } from "../security/safe-regex.js";
export {
  appendRegularFile,
  FsSafeError,
  openLocalFileSafely,
  pathExists,
  pathExistsSync,
  readRegularFile,
  resolveLocalPathFromRootsSync,
  readRegularFileSync,
  root,
  statRegularFile,
  statRegularFileSync,
  writeExternalFileWithinRoot,
  withTimeout,
} from "../infra/fs-safe.js";

export { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
export { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
export { normalizeHostname } from "../infra/net/hostname.js";
export {
  SsrFBlockedError,
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  resolvePinnedHostnameWithPolicy,
} from "../infra/net/ssrf.js";
export type { LookupFn, SsrFPolicy } from "../infra/net/ssrf.js";
export { isPathInside } from "../infra/path-guards.js";
export {
  canonicalPathFromExistingAncestor,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
} from "../infra/fs-safe.js";
export { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
export { privateFileStoreSync } from "../infra/private-file-store.js";
export { movePathWithCopyFallback, replaceFileAtomic } from "../infra/replace-file.js";

export { assertNoSymlinkParents, assertNoSymlinkParentsSync } from "../infra/fs-safe-advanced.js";
export { ensurePortAvailable } from "../infra/ports.js";

export {
  resolveExistingPathsWithinRoot,
  pathScope,
  resolveStrictExistingPathsWithinRoot,
} from "../infra/root-paths.js";

export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { redactSensitiveText } from "../logging/redact.js";
export { safeEqualSecret } from "../security/secret-equal.js";

export { resolvePinnedMainDmOwnerFromAllowlist } from "../security/dm-policy-shared.js";
