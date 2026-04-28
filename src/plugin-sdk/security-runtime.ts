// Public security/policy helpers for plugins that need shared trust and DM gating logic.

export * from "../secrets/channel-secret-collector-runtime.js";
export * from "../secrets/runtime-shared.js";
export * from "../secrets/shared.js";
export type * from "../secrets/target-registry-types.js";
export * from "../security/channel-metadata.js";
export * from "../security/context-visibility.js";
export * from "../security/dm-policy-shared.js";
export * from "../security/external-content.js";
export * from "../security/safe-regex.js";
export {
  SafeOpenError,
  openFileWithinRoot,
  writeFileFromPathWithinRoot,
} from "../infra/fs-safe.js";
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
export { ensurePortAvailable } from "../infra/ports.js";
export { generateSecureToken } from "../infra/secure-random.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { redactSensitiveText } from "../logging/redact.js";
export { safeEqualSecret } from "../security/secret-equal.js";
