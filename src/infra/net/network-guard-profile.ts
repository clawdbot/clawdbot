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

const PROFILE_KEYS = ["version", "target", "route", "addressPolicy"] as const;
const TARGET_KEYS = ["protocol", "origin", "hostname", "port"] as const;
const ROUTE_KEYS = ["mode", "resolution", "tls"] as const;
const ADDRESS_POLICY_KEYS = [
  "mode",
  "trustedHostnames",
  "hostnameAllowlist",
  "allowedPrivateCidrs",
  "allowRfc2544BenchmarkRange",
  "allowIpv6UniqueLocalRange",
  "dnsRebinding",
] as const;
const DNS_REBINDING_KEYS = ["policy", "enforcement"] as const;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Unsupported ${label} shape`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).toSorted();
  const sortedExpectedKeys = [...expectedKeys].toSorted();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`Unsupported ${label} shape`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label}`);
  }
}

function resolveUrlPort(url: URL): number {
  if (url.port) {
    return Number.parseInt(url.port, 10);
  }
  return url.protocol === "https:" ? 443 : 80;
}

export function assertNetworkGuardProfileV1(
  profile: unknown,
): asserts profile is NetworkGuardProfileV1 {
  assertRecord(profile, "network guard profile");
  assertExactKeys(profile, PROFILE_KEYS, "network guard profile");
  if (profile.version !== NETWORK_GUARD_PROFILE_VERSION) {
    throw new Error(`Unsupported network guard profile version: ${String(profile.version)}`);
  }

  assertRecord(profile.target, "network guard target");
  assertExactKeys(profile.target, TARGET_KEYS, "network guard target");
  if (profile.target.protocol !== "http:" && profile.target.protocol !== "https:") {
    throw new Error("Invalid network guard target protocol");
  }
  assertNonEmptyString(profile.target.origin, "network guard target origin");
  assertNonEmptyString(profile.target.hostname, "network guard target hostname");
  if (
    typeof profile.target.port !== "number" ||
    !Number.isInteger(profile.target.port) ||
    profile.target.port < 1 ||
    profile.target.port > 65_535
  ) {
    throw new Error("Invalid network guard target port");
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(profile.target.origin);
  } catch {
    throw new Error("Invalid network guard target origin");
  }
  if (
    parsedOrigin.origin !== profile.target.origin ||
    parsedOrigin.protocol !== profile.target.protocol ||
    normalizeHostname(parsedOrigin.hostname) !== normalizeHostname(profile.target.hostname) ||
    resolveUrlPort(parsedOrigin) !== profile.target.port
  ) {
    throw new Error("Network guard target origin is inconsistent");
  }

  assertRecord(profile.route, "network guard route");
  assertExactKeys(profile.route, ROUTE_KEYS, "network guard route");
  const routeModes: readonly unknown[] = [
    "direct",
    "environment-proxy",
    "explicit-proxy",
    "managed-proxy",
  ];
  if (!routeModes.includes(profile.route.mode)) {
    throw new Error("Invalid network guard route mode");
  }
  const resolutionModes: readonly unknown[] = ["pinned", "proxy", "caller"];
  if (!resolutionModes.includes(profile.route.resolution)) {
    throw new Error("Invalid network guard resolution mode");
  }
  if (profile.route.tls !== "required" && profile.route.tls !== "cleartext") {
    throw new Error("Invalid network guard TLS posture");
  }
  const expectedTls = profile.target.protocol === "https:" ? "required" : "cleartext";
  if (profile.route.tls !== expectedTls) {
    throw new Error("Network guard route TLS posture is inconsistent with the target");
  }
  const usesProxyRoute = profile.route.mode !== "direct";
  if ((profile.route.resolution === "proxy") !== usesProxyRoute) {
    throw new Error("Network guard resolution is inconsistent with the route");
  }

  assertRecord(profile.addressPolicy, "network guard address policy");
  assertExactKeys(profile.addressPolicy, ADDRESS_POLICY_KEYS, "network guard address policy");
  const addressModes: readonly unknown[] = ["public-only", "trusted-host", "allow-private-network"];
  if (!addressModes.includes(profile.addressPolicy.mode)) {
    throw new Error("Invalid network guard address policy mode");
  }
  assertStringArray(profile.addressPolicy.trustedHostnames, "network guard trusted hostnames");
  assertStringArray(profile.addressPolicy.hostnameAllowlist, "network guard hostname allowlist");
  assertStringArray(
    profile.addressPolicy.allowedPrivateCidrs,
    "network guard allowed private CIDRs",
  );
  assertBoolean(
    profile.addressPolicy.allowRfc2544BenchmarkRange,
    "network guard RFC 2544 benchmark-range flag",
  );
  assertBoolean(
    profile.addressPolicy.allowIpv6UniqueLocalRange,
    "network guard IPv6 unique-local-range flag",
  );

  assertRecord(profile.addressPolicy.dnsRebinding, "network guard DNS rebinding policy");
  assertExactKeys(
    profile.addressPolicy.dnsRebinding,
    DNS_REBINDING_KEYS,
    "network guard DNS rebinding policy",
  );
  if (profile.addressPolicy.dnsRebinding.policy !== "reject") {
    throw new Error("Invalid network guard DNS rebinding policy");
  }
  const expectedEnforcement =
    profile.route.resolution === "pinned"
      ? "local-pinned"
      : profile.route.resolution === "proxy"
        ? "connection-owner-required"
        : "not-enforced";
  if (profile.addressPolicy.dnsRebinding.enforcement !== expectedEnforcement) {
    throw new Error("Network guard DNS rebinding enforcement is inconsistent");
  }
}

export function assertNetworkGuardProfileTarget(
  profile: NetworkGuardProfileV1,
  requestUrl: string,
): void {
  assertNetworkGuardProfileV1(profile);
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
