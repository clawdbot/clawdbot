/**
 * SSRF policy adjustments for Chrome DevTools Protocol reachability checks.
 *
 * CDP control-plane probes may target loopback even when page navigation policy
 * is stricter, so this module scopes the exception to browser control only.
 */
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { normalizeHostname } from "../sdk-security-runtime.js";
import { CHROME_MCP_ENDPOINT_FLAGS } from "./chrome-mcp-contracts.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserProfileUnavailableError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { isCdpHostnameTrustedByPolicy, withExactHostnamePolicy } from "./ssrf-policy-helpers.js";

// Synthetic exact-host CDP policies must retain the operator's original intent;
// otherwise Chrome MCP cannot distinguish default control-plane scoping from a
// user-authored restriction that genuinely requires pinned transport.
const cdpControlSourcePolicyByScopedPolicy = new WeakMap<SsrFPolicy, SsrFPolicy>();

function withCdpControlHostname(
  profile: ResolvedBrowserProfile,
  ssrfPolicy?: SsrFPolicy,
  requireAllowlistMatch = false,
): SsrFPolicy | undefined {
  const cdpHost = normalizeHostname(profile.cdpHost);
  if (!ssrfPolicy || !cdpHost) {
    return ssrfPolicy;
  }
  if (requireAllowlistMatch && !isCdpHostnameTrustedByPolicy(ssrfPolicy, cdpHost)) {
    return ssrfPolicy;
  }
  const scopedPolicy = withExactHostnamePolicy(ssrfPolicy, cdpHost);
  cdpControlSourcePolicyByScopedPolicy.set(scopedPolicy, ssrfPolicy);
  return scopedPolicy;
}

function hasPolicyEntries(values?: string[]): boolean {
  return (values ?? []).some((value) => value.trim().length > 0);
}

function requiresPinnedChromeMcpCdpTransport(cdpPolicy?: SsrFPolicy): boolean {
  if (!cdpPolicy) {
    return false;
  }
  const policyIntent = cdpControlSourcePolicyByScopedPolicy.get(cdpPolicy) ?? cdpPolicy;
  const hasScopedPolicy =
    policyIntent.allowRfc2544BenchmarkRange === true ||
    policyIntent.allowIpv6UniqueLocalRange === true ||
    hasPolicyEntries(policyIntent.allowedHostnames) ||
    hasPolicyEntries(policyIntent.hostnameAllowlist) ||
    hasPolicyEntries(policyIntent.allowedOrigins);
  return !(
    !hasScopedPolicy &&
    (policyIntent.dangerouslyAllowPrivateNetwork === true ||
      policyIntent.allowPrivateNetwork === true)
  );
}

function hasChromeMcpEndpointArg(args?: string[]): boolean {
  return (args ?? []).some((arg) => {
    const [name] = arg.split("=", 1);
    return CHROME_MCP_ENDPOINT_FLAGS.has(name ?? arg);
  });
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

export function assertChromeMcpCdpTransportAllowed(
  profile: ResolvedBrowserProfile,
  cdpPolicy?: SsrFPolicy,
): void {
  const hasExplicitEndpoint = Boolean(profile.cdpUrl) || hasChromeMcpEndpointArg(profile.mcpArgs);
  if (profile.driver !== "existing-session" || !hasExplicitEndpoint) {
    return;
  }
  if (!requiresPinnedChromeMcpCdpTransport(cdpPolicy)) {
    return;
  }
  throw new BrowserProfileUnavailableError(
    `Browser profile "${profile.name}" uses Chrome MCP with an explicit CDP endpoint, but the active Browser CDP policy requires OpenClaw to pin the approved endpoint. Chrome MCP cannot carry that pinned transport across its subprocess boundary. Use driver "openclaw" for guarded CDP endpoints, or remove cdpUrl and browserUrl/wsEndpoint mcpArgs from this existing-session profile so Chrome MCP attaches to a host-local Chrome profile.`,
  );
}
