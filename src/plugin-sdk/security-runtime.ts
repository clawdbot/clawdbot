/** Public security runtime helpers for plugin-side trust boundaries. */

export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  fileExists,
  readRegularFile,
  readRegularFileSync,
  statRegularFile,
  statRegularFileSync,
} from "./file-access-runtime.js";

export {
  buildChannelMetadata,
  buildUntrustedChannelMetadata,
} from "../security/channel-metadata.js";
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
export {
  truncateSanitizedExternalContent,
  wrapExternalContent,
  wrapWebContent,
} from "../security/external-content.js";
export { compileSafeRegexDetailed } from "../security/safe-regex.js";
export type { SafeRegexRejectReason } from "../security/safe-regex.js";
export {
  appendRegularFile,
  FsSafeError,
  openLocalFileSafely,
  pathExists,
  pathExistsSync,
  resolveLocalPathFromRootsSync,
  root,
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
