import { normalizeHostname } from "./hostname.js";

export const NETWORK_GUARD_PROFILE_VERSION = "network-guard/v1" as const;

export type NetworkGuardRouteMode =
  | "direct"
  | "environment-proxy"
  | "explicit-proxy"
  | "managed-proxy";

export type NetworkGuardResolutionMode = "pinned" | "proxy" | "caller";

export type NetworkGuardAddressMode = "public-only" | "trusted-host" | "allow-private-network";

export type NetworkGuardProfileV1 = {
  version: typeof NETWORK_GUARD_PROFILE_VERSION;
  target: {
    protocol: "http:" | "https:";
    origin: string;
    hostname: string;
    port: number;
  };
  route: {
    mode: NetworkGuardRouteMode;
    resolution: NetworkGuardResolutionMode;
    tls: "required" | "cleartext";
  };
  addressPolicy: {
    mode: NetworkGuardAddressMode;
    trustedHostnames: string[];
    hostnameAllowlist: string[];
    allowedPrivateCidrs: string[];
    allowRfc2544BenchmarkRange: boolean;
    allowIpv6UniqueLocalRange: boolean;
    dnsRebinding: {
      policy: "reject";
      enforcement: "local-pinned" | "connection-owner-required" | "not-enforced";
    };
  };
};

function resolveUrlPort(url: URL): number {
  if (url.port) {
    return Number.parseInt(url.port, 10);
  }
  return url.protocol === "https:" ? 443 : 80;
}

export function assertNetworkGuardProfileTarget(
  profile: NetworkGuardProfileV1,
  requestUrl: string,
): void {
  if (profile.version !== NETWORK_GUARD_PROFILE_VERSION) {
    throw new Error(`Unsupported network guard profile version: ${profile.version}`);
  }
  const parsed = new URL(requestUrl);
  const hostname = normalizeHostname(parsed.hostname);
  if (
    parsed.protocol !== profile.target.protocol ||
    parsed.origin !== profile.target.origin ||
    hostname !== profile.target.hostname ||
    resolveUrlPort(parsed) !== profile.target.port
  ) {
    throw new Error("Network guard profile target does not match one-hop request URL");
  }
}

export function assertLocalNetworkGuardPrepared(params: {
  profile: NetworkGuardProfileV1;
  requestUrl: string;
  hasDispatcher: boolean;
}): void {
  assertNetworkGuardProfileTarget(params.profile, params.requestUrl);
  const expectedEnforcement =
    params.profile.route.resolution === "pinned"
      ? "local-pinned"
      : params.profile.route.resolution === "proxy"
        ? "connection-owner-required"
        : "not-enforced";
  if (params.profile.addressPolicy.dnsRebinding.enforcement !== expectedEnforcement) {
    throw new Error("Network guard DNS rebinding enforcement does not match resolution mode");
  }
  if (expectedEnforcement === "local-pinned" && !params.hasDispatcher) {
    throw new Error("Pinned network guard profile requires a prepared local dispatcher");
  }
}
