/**
 * SSRF policy helpers for Browser routes that need one-off hostname grants.
 */
import { isPrivateNetworkAllowedByPolicy, type SsrFPolicy } from "../infra/net/ssrf.js";
import { matchesHostnameAllowlist, normalizeHostname } from "../sdk-security-runtime.js";

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

/** Return true when policy already trusts this hostname as a private-network destination. */
export function isCdpHostnameTrustedByPolicy(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return false;
  }
  const allowedHostnames = (ssrfPolicy?.allowedHostnames ?? [])
    .map((pattern) => normalizeHostname(pattern))
    .filter(Boolean);
  if (allowedHostnames.length === 0) {
    return isPrivateNetworkAllowedByPolicy(ssrfPolicy);
  }
  if (allowedHostnames.some((pattern) => pattern === "*" || pattern === "*.")) {
    return true;
  }
  return matchesHostnameAllowlist(normalizedHostname, allowedHostnames);
}

/** Return true when the policy blocklist denies this exact CDP hostname. */
export function isCdpHostnameBlockedByPolicy(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  const blockedHostnames = (ssrfPolicy?.blockedHostnames ?? [])
    .map((pattern) => normalizeHostname(pattern))
    .filter(Boolean);
  // An empty allowlist matches everything; an empty blocklist must block nothing.
  if (!normalizedHostname || blockedHostnames.length === 0) {
    return false;
  }
  return matchesHostnameAllowlist(normalizedHostname, blockedHostnames);
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
