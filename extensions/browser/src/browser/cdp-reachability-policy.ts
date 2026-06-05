/**
 * SSRF policy adjustments for Chrome DevTools Protocol reachability checks.
 *
 * CDP control-plane probes may target loopback even when page navigation policy
 * is stricter, so this module scopes the exception to browser control only.
 */
import { isPrivateNetworkAllowedByPolicy, type SsrFPolicy } from "../infra/net/ssrf.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { withAllowedHostname } from "./ssrf-policy-helpers.js";

function withCdpHostnameAllowed(
  profile: ResolvedBrowserProfile,
  ssrfPolicy?: SsrFPolicy,
): SsrFPolicy | undefined {
  if (!ssrfPolicy || !profile.cdpHost) {
    return ssrfPolicy;
  }
  if (isPrivateNetworkAllowedByPolicy(ssrfPolicy)) {
    return ssrfPolicy;
  }
  return withAllowedHostname(ssrfPolicy, profile.cdpHost);
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
  return withCdpHostnameAllowed(profile, ssrfPolicy);
}

/** Alias used by callers that treat reachability and control as one CDP policy. */
export const resolveCdpControlPolicy = resolveCdpReachabilityPolicy;
