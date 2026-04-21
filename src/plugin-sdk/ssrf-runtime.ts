// Narrow SSRF helpers for extensions that need pinned-dispatcher and policy
// utilities without loading the full infra-runtime surface.

export {
  closeDispatcher,
  createPinnedDispatcher,
  isBlockedHostnameOrIp,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
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
