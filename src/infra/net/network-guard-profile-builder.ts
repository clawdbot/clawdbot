import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { normalizeHostname } from "./hostname.js";
import {
  NETWORK_GUARD_PROFILE_VERSION,
  type NetworkGuardAddressMode,
  type NetworkGuardProfileV1,
  type NetworkGuardResolutionMode,
  type NetworkGuardRouteMode,
} from "./network-guard-profile.js";
import {
  isPrivateNetworkAllowedByPolicy,
  normalizeHostnameAllowlist,
  type PinnedDispatcherPolicy,
  type SsrFPolicy,
} from "./ssrf.js";

function normalizePolicyHostnames(values?: string[]): string[] {
  return normalizeUniqueStringEntries(values?.map((value) => normalizeHostname(value)));
}

export function resolveNetworkGuardRouteV1(
  dispatcherPolicy: Pick<PinnedDispatcherPolicy, "mode"> | undefined,
  resolutionMode: NetworkGuardResolutionMode,
): {
  routeMode: NetworkGuardRouteMode;
  resolutionMode: NetworkGuardResolutionMode;
} {
  if (dispatcherPolicy?.mode === "env-proxy") {
    return { routeMode: "environment-proxy", resolutionMode };
  }
  if (dispatcherPolicy?.mode === "explicit-proxy") {
    return { routeMode: "explicit-proxy", resolutionMode };
  }
  return { routeMode: "direct", resolutionMode };
}

export function buildNetworkGuardProfileV1(params: {
  url: URL;
  policy?: SsrFPolicy;
  routeMode: NetworkGuardRouteMode;
  resolutionMode: NetworkGuardResolutionMode;
  allowedPrivateCidrs?: string[];
}): NetworkGuardProfileV1 {
  const hostname = normalizeHostname(params.url.hostname);
  if (!hostname) {
    throw new Error("Invalid network guard profile hostname");
  }
  const trustedHostnames = normalizePolicyHostnames(params.policy?.allowedHostnames);
  const addressMode: NetworkGuardAddressMode = isPrivateNetworkAllowedByPolicy(params.policy)
    ? "allow-private-network"
    : trustedHostnames.includes(hostname)
      ? "trusted-host"
      : "public-only";
  return {
    version: NETWORK_GUARD_PROFILE_VERSION,
    target: {
      protocol: params.url.protocol as "http:" | "https:",
      origin: params.url.origin,
      hostname,
      port: params.url.port
        ? Number.parseInt(params.url.port, 10)
        : params.url.protocol === "https:"
          ? 443
          : 80,
    },
    route: {
      mode: params.routeMode,
      resolution: params.resolutionMode,
      tls: params.url.protocol === "https:" ? "required" : "cleartext",
    },
    addressPolicy: {
      mode: addressMode,
      trustedHostnames,
      hostnameAllowlist: [
        ...normalizeHostnameAllowlist(params.policy?.hostnameAllowlist),
      ].toSorted(),
      allowedPrivateCidrs: normalizeUniqueStringEntries(params.allowedPrivateCidrs).toSorted(),
      allowRfc2544BenchmarkRange: params.policy?.allowRfc2544BenchmarkRange === true,
      allowIpv6UniqueLocalRange: params.policy?.allowIpv6UniqueLocalRange === true,
      dnsRebinding: {
        policy: "reject",
        enforcement:
          params.resolutionMode === "pinned"
            ? "local-pinned"
            : params.resolutionMode === "proxy"
              ? "connection-owner-required"
              : "not-enforced",
      },
    },
  };
}
