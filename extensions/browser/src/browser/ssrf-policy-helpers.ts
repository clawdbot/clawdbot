/**
 * SSRF policy helpers for Browser routes that need one-off hostname grants.
 */
import { isPrivateNetworkAllowedByPolicy, type SsrFPolicy } from "../infra/net/ssrf.js";

// Exact-host CDP scoping replaces allowedHostnames. Preserve whether the source
// policy allowed authority changes before that synthetic allowlist was added.
const discoveredCdpAuthorityChangeByPolicy = new WeakMap<SsrFPolicy, boolean>();

export function allowsDiscoveredCdpAuthorityChange(ssrfPolicy?: SsrFPolicy): boolean {
  const prepared = ssrfPolicy ? discoveredCdpAuthorityChangeByPolicy.get(ssrfPolicy) : undefined;
  if (prepared !== undefined) {
    return prepared;
  }
  const hasExplicitAllowedHostnames = (ssrfPolicy?.allowedHostnames ?? []).some(
    (hostname) => hostname.trim().length > 0,
  );
  return (
    !ssrfPolicy || (!hasExplicitAllowedHostnames && isPrivateNetworkAllowedByPolicy(ssrfPolicy))
  );
}

/** Returns an SSRF policy restricted to one exact control-plane hostname. */
export function withExactHostnamePolicy(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): SsrFPolicy {
  const { allowedOrigins: _allowedOrigins, ...basePolicy } = ssrfPolicy ?? {};
  const scopedPolicy = {
    ...basePolicy,
    allowedHostnames: [hostname],
  };
  discoveredCdpAuthorityChangeByPolicy.set(
    scopedPolicy,
    allowsDiscoveredCdpAuthorityChange(ssrfPolicy),
  );
  return scopedPolicy;
}
