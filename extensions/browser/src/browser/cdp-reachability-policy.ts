/**
 * SSRF policy adjustments for Chrome DevTools Protocol reachability checks.
 *
 * CDP control-plane probes may target loopback even when page navigation policy
 * is stricter, so this module scopes the exception to browser control only.
 */
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { matchesHostnameAllowlist, normalizeHostname } from "../sdk-security-runtime.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { withExactHostnamePolicy } from "./ssrf-policy-helpers.js";

function withCdpControlHostname(
  profile: ResolvedBrowserProfile,
  ssrfPolicy?: SsrFPolicy,
  requireAllowlistMatch = false,
): SsrFPolicy | undefined {
  const cdpHost = normalizeHostname(profile.cdpHost);
  if (!ssrfPolicy || !cdpHost) {
    return ssrfPolicy;
  }
  const allowedHostnames = (ssrfPolicy.allowedHostnames ?? [])
    .map((pattern) => normalizeHostname(pattern))
    .filter((pattern) => pattern && pattern !== "*" && pattern !== "*.");
  if (
    requireAllowlistMatch &&
    allowedHostnames.length > 0 &&
    !matchesHostnameAllowlist(cdpHost, allowedHostnames)
  ) {
    return ssrfPolicy;
  }
  return withExactHostnamePolicy(ssrfPolicy, cdpHost);
}

export function resolveCdpReachabilityPolicy(
  profile: ResolvedBrowserProfile,
  ssrfPolicy?: SsrFPolicy,
): SsrFPolicy | undefined {
  const capabilities = getBrowserProfileCapabilities(profile);
  // The browser SSRF policy protects page/network navigation, not OpenClaw's
  // own local CDP control plane. Explicit local loopback CDP profiles should
  // not self-block health/control checks just because they target 127.0.0.1.
  if (!capabilities.isRemote && profile.cdpIsLoopback && profile.driver === "openclaw") {
    return undefined;
  }
  // Configured local relays are control-plane endpoints even when page policy
  // excludes loopback. Remote CDP hosts must still satisfy an explicit
  // allowedHostnames before their control policy is narrowed.
  return withCdpControlHostname(profile, ssrfPolicy, capabilities.isRemote);
}

/** Alias used by callers that treat reachability and control as one CDP policy. */
export const resolveCdpControlPolicy = resolveCdpReachabilityPolicy;
