// Narrow SSRF helpers for extensions that need pinned-dispatcher and policy
// utilities without loading the full infra-runtime surface.
import {
  isCanonicalDottedDecimalIPv4 as isCanonicalDottedDecimalIPv4Impl,
  isLoopbackIpAddress as isLoopbackIpAddressImpl,
} from "@openclaw/net-policy/ip";

/** True only for canonical four-part dotted-decimal IPv4 literals. */
export function isCanonicalDottedDecimalIPv4(raw: string | undefined): boolean {
  return isCanonicalDottedDecimalIPv4Impl(raw);
}

/** True when a canonical IP literal is loopback, including IPv4-mapped IPv6. */
export function isLoopbackIpAddress(raw: string | undefined): boolean {
  return isLoopbackIpAddressImpl(raw);
}

export {
  closeDispatcher,
  createPinnedDispatcher,
  SsrFBlockedError,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
export { formatErrorMessage } from "../infra/errors.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export {
  assertHttpUrlTargetsPrivateNetwork,
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  createLegacyPrivateNetworkDoctorContract,
  hasLegacyFlatAllowPrivateNetworkAlias,
  isPrivateNetworkOptInEnabled,
  mergeSsrFPolicies,
  migrateLegacyFlatAllowPrivateNetworkAlias,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  ssrfPolicyFromPrivateNetworkOptIn,
  ssrfPolicyFromAllowPrivateNetwork,
} from "./ssrf-policy.js";
export { isPrivateOrLoopbackHost } from "../gateway/net.js";
