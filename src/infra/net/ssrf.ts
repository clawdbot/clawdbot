import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Dispatcher } from "undici";
import {
  extractEmbeddedIpv4FromIpv6,
  isBlockedSpecialUseIpv4Address,
  isBlockedSpecialUseIpv6Address,
  isCanonicalDottedDecimalIPv4,
  type Ipv4SpecialUseBlockOptions,
  isIpv4Address,
  isLegacyIpv4Literal,
  parseCanonicalIpAddress,
  parseLooseIpAddress,
} from "../../shared/net/ip.js";
import { normalizeHostname } from "./hostname.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "./undici-runtime.js";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

type LookupResult = LookupAddress | LookupAddress[];

export class SsrFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrFBlockedError";
  }
}

export type LookupFn = typeof dnsLookup;

export type SsrFPolicy = {
  allowPrivateNetwork?: boolean;
  dangerouslyAllowPrivateNetwork?: boolean;
  allowRfc2544BenchmarkRange?: boolean;
  allowedHostnames?: string[];
  hostnameAllowlist?: string[];
};

export function ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

function normalizeHostnameSet(values?: string[]): Set<string> {
  if (!values || values.length === 0) {
    return new Set<string>();
  }
  return new Set(values.map((value) => normalizeHostname(value)).filter(Boolean));
}

export function normalizeHostnameAllowlist(values?: string[]): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeHostname(value))
        .filter((value) => value !== "*" && value !== "*." && value.length > 0),
    ),
  );
}

export function isPrivateNetworkAllowedByPolicy(policy?: SsrFPolicy): boolean {
  return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}

function shouldSkipPrivateNetworkChecks(hostname: string, policy?: SsrFPolicy): boolean {
  return (
    isPrivateNetworkAllowedByPolicy(policy) ||
    normalizeHostnameSet(policy?.allowedHostnames).has(hostname)
  );
}

function resolveIpv4SpecialUseBlockOptions(policy?: SsrFPolicy): Ipv4SpecialUseBlockOptions {
  return {
    allowRfc2544BenchmarkRange: policy?.allowRfc2544BenchmarkRange === true,
  };
}

export function isHostnameAllowedByPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    if (!suffix || hostname === suffix) {
      return false;
    }
    return hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

export function matchesHostnameAllowlist(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.some((pattern) => isHostnameAllowedByPattern(hostname, pattern));
}

function looksLikeUnsupportedIpv4Literal(address: string): boolean {
  const parts = address.split(".");
  if (parts.length === 0 || parts.length > 4) {
    return false;
  }
  if (parts.some((part) => part.length === 0)) {
    return true;
  }
  // Tighten only "ipv4-ish" literals (numbers + optional 0x prefix). Hostnames like
  // "example.com" must stay in hostname policy handling and not be treated as malformed IPs.
  return parts.every((part) => /^[0-9]+$/.test(part) || /^0x/i.test(part));
}

// Returns true for private/internal and special-use non-global addresses.
export function isPrivateIpAddress(address: string, policy?: SsrFPolicy): boolean {
  const normalized = normalizeHostname(address);
  if (!normalized) {
    return false;
  }
  const blockOptions = resolveIpv4SpecialUseBlockOptions(policy);

  const strictIp = parseCanonicalIpAddress(normalized);
  if (strictIp) {
    if (isIpv4Address(strictIp)) {
      return isBlockedSpecialUseIpv4Address(strictIp, blockOptions);
    }
    if (isBlockedSpecialUseIpv6Address(strictIp)) {
      return true;
    }
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(strictIp);
    if (embeddedIpv4) {
      return isBlockedSpecialUseIpv4Address(embeddedIpv4, blockOptions);
    }
    return false;
  }

  // Security-critical parse failures should fail closed for any malformed IPv6 literal.
  if (normalized.includes(":") && !parseLooseIpAddress(normalized)) {
    return true;
  }

  if (!isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized)) {
    return true;
  }
  if (looksLikeUnsupportedIpv4Literal(normalized)) {
    return true;
  }
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  return isBlockedHostnameNormalized(normalized);
}

function isBlockedHostnameNormalized(normalized: string): boolean {
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

export function isBlockedHostnameOrIp(hostname: string, policy?: SsrFPolicy): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  return isBlockedHostnameNormalized(normalized) || isPrivateIpAddress(normalized, policy);
}

const BLOCKED_HOST_OR_IP_MESSAGE = "Blocked hostname or private/internal/special-use IP address";
const BLOCKED_RESOLVED_IP_MESSAGE = "Blocked: resolves to private/internal/special-use IP address";

function assertAllowedHostOrIpOrThrow(hostnameOrIp: string, policy?: SsrFPolicy): void {
  if (isBlockedHostnameOrIp(hostnameOrIp, policy)) {
    throw new SsrFBlockedError(BLOCKED_HOST_OR_IP_MESSAGE);
  }
}

function resolveHostnamePolicyChecks(
  hostname: string,
  policy?: SsrFPolicy,
): {
  normalized: string;
  skipPrivateNetworkChecks: boolean;
} {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new Error("Invalid hostname");
  }

  const hostnameAllowlist = normalizeHostnameAllowlist(policy?.hostnameAllowlist);
  const skipPrivateNetworkChecks = shouldSkipPrivateNetworkChecks(normalized, policy);

  if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) {
    throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${hostname}`);
  }

  if (!skipPrivateNetworkChecks) {
    // Fail fast for literal hosts/IPs before any DNS lookup side-effects.
    assertAllowedHostOrIpOrThrow(normalized, policy);
  }

  return { normalized, skipPrivateNetworkChecks };
}

function assertAllowedResolvedAddressesOrThrow(
  results: readonly LookupAddress[],
  policy?: SsrFPolicy,
): void {
  for (const entry of results) {
    // Reuse the exact same host/IP classifier as the pre-DNS check to avoid drift.
    if (isBlockedHostnameOrIp(entry.address, policy)) {
      throw new SsrFBlockedError(BLOCKED_RESOLVED_IP_MESSAGE);
    }
  }
}

function normalizeLookupResults(results: LookupResult): readonly LookupAddress[] {
  if (Array.isArray(results)) {
    return results;
  }
  return [results];
}

export function createPinnedLookup(params: {
  hostname: string;
  addresses: string[];
  fallback?: typeof dnsLookupCb;
}): typeof dnsLookupCb {
  const normalizedHost = normalizeHostname(params.hostname);
  if (params.addresses.length === 0) {
    throw new Error(`Pinned lookup requires at least one address for ${params.hostname}`);
  }
  const fallback = params.fallback ?? dnsLookupCb;
  const fallbackLookup = fallback as unknown as (
    hostname: string,
    callback: LookupCallback,
  ) => void;
  const fallbackWithOptions = fallback as unknown as (
    hostname: string,
    options: unknown,
    callback: LookupCallback,
  ) => void;
  const records = params.addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  let index = 0;

  return ((host: string, options?: unknown, callback?: unknown) => {
    const cb: LookupCallback =
      typeof options === "function" ? (options as LookupCallback) : (callback as LookupCallback);
    if (!cb) {
      return;
    }
    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === "function" || options === undefined) {
        return fallbackLookup(host, cb);
      }
      return fallbackWithOptions(host, options, cb);
    }

    const opts =
      typeof options === "object" && options !== null
        ? (options as { all?: boolean; family?: number })
        : {};
    const requestedFamily =
      typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    const usable = candidates.length > 0 ? candidates : records;
    if (opts.all) {
      cb(null, usable as LookupAddress[]);
      return;
    }
    const chosen = usable[index % usable.length];
    index += 1;
    cb(null, chosen.address, chosen.family);
  }) as typeof dnsLookupCb;
}

export type PinnedHostname = {
  hostname: string;
  addresses: string[];
  lookup: typeof dnsLookupCb;
};

export type PinnedHostnameOverride = {
  hostname: string;
  addresses: string[];
};

export type PinnedDispatcherPolicy =
  | {
      mode: "direct";
      connect?: Record<string, unknown>;
      pinnedHostname?: PinnedHostnameOverride;
    }
  | {
      mode: "env-proxy";
      connect?: Record<string, unknown>;
      proxyTls?: Record<string, unknown>;
      pinnedHostname?: PinnedHostnameOverride;
    }
  | {
      mode: "explicit-proxy";
      proxyUrl: string;
      allowPrivateProxy?: boolean;
      proxyTls?: Record<string, unknown>;
      pinnedHostname?: PinnedHostnameOverride;
    };

function dedupeAndPreferIpv4(results: readonly LookupAddress[]): string[] {
  const seen = new Set<string>();
  const ipv4: string[] = [];
  const otherFamilies: string[] = [];
  for (const entry of results) {
    if (seen.has(entry.address)) {
      continue;
    }
    seen.add(entry.address);
    if (entry.family === 4) {
      ipv4.push(entry.address);
      continue;
    }
    otherFamilies.push(entry.address);
  }
  return [...ipv4, ...otherFamilies];
}

export async function resolvePinnedHostnameWithPolicy(
  hostname: string,
  params: { lookupFn?: LookupFn; policy?: SsrFPolicy } = {},
): Promise<PinnedHostname> {
  const { normalized, skipPrivateNetworkChecks } = resolveHostnamePolicyChecks(
    hostname,
    params.policy,
  );

  const lookupFn = params.lookupFn ?? dnsLookup;
  const results = normalizeLookupResults(
    (await lookupFn(normalized, { all: true })) as LookupResult,
  );
  if (results.length === 0) {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }

  if (!skipPrivateNetworkChecks) {
    // Phase 2: re-check DNS answers so public hostnames cannot pivot to private targets.
    assertAllowedResolvedAddressesOrThrow(results, params.policy);
  }

  // Prefer addresses returned as IPv4 by DNS family metadata before other
  // families so Happy Eyeballs and pinned round-robin both attempt IPv4 first.
  const addresses = dedupeAndPreferIpv4(results);
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }

  return {
    hostname: normalized,
    addresses,
    lookup: createPinnedLookup({ hostname: normalized, addresses }),
  };
}

export function assertHostnameAllowedWithPolicy(hostname: string, policy?: SsrFPolicy): string {
  return resolveHostnamePolicyChecks(hostname, policy).normalized;
}

export async function resolvePinnedHostname(
  hostname: string,
  lookupFn: LookupFn = dnsLookup,
): Promise<PinnedHostname> {
  return await resolvePinnedHostnameWithPolicy(hostname, { lookupFn });
}

function withPinnedLookup(
  lookup: PinnedHostname["lookup"],
  connect?: Record<string, unknown>,
): Record<string, unknown> {
  return connect ? { ...connect, lookup } : { lookup };
}

function resolvePinnedDispatcherLookup(
  pinned: PinnedHostname,
  override?: PinnedHostnameOverride,
  policy?: SsrFPolicy,
): PinnedHostname["lookup"] {
  if (!override) {
    return pinned.lookup;
  }
  const normalizedOverrideHost = normalizeHostname(override.hostname);
  if (!normalizedOverrideHost || normalizedOverrideHost !== pinned.hostname) {
    throw new Error(
      `Pinned dispatcher override hostname mismatch: expected ${pinned.hostname}, got ${override.hostname}`,
    );
  }
  const records = override.addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  if (!shouldSkipPrivateNetworkChecks(pinned.hostname, policy)) {
    assertAllowedResolvedAddressesOrThrow(records, policy);
  }
  return createPinnedLookup({
    hostname: pinned.hostname,
    addresses: [...override.addresses],
    fallback: pinned.lookup,
  });
}

export function createPinnedDispatcher(
  pinned: PinnedHostname,
  policy?: PinnedDispatcherPolicy,
  ssrfPolicy?: SsrFPolicy,
): Dispatcher {
  const lookup = resolvePinnedDispatcherLookup(pinned, policy?.pinnedHostname, ssrfPolicy);

  if (!policy || policy.mode === "direct") {
    return createHttp1Agent({
      connect: withPinnedLookup(lookup, policy?.connect),
    });
  }

  if (policy.mode === "env-proxy") {
    return createHttp1EnvHttpProxyAgent({
      connect: withPinnedLookup(lookup, policy.connect),
      ...(policy.proxyTls ? { proxyTls: { ...policy.proxyTls } } : {}),
    });
  }

  const proxyUrl = policy.proxyUrl.trim();
  const requestTls = withPinnedLookup(lookup, policy.proxyTls);
  if (!requestTls) {
    return createHttp1ProxyAgent({ uri: proxyUrl });
  }
  return createHttp1ProxyAgent({
    uri: proxyUrl,
    // `PinnedDispatcherPolicy.proxyTls` historically carried target-hop
    // transport hints for explicit proxies. Translate that to undici's
    // `requestTls` so HTTPS proxy tunnels keep the pinned DNS lookup.
    requestTls,
  });
}

export async function closeDispatcher(dispatcher?: Dispatcher | null): Promise<void> {
  if (!dispatcher) {
    return;
  }
  const candidate = dispatcher as { close?: () => Promise<void> | void; destroy?: () => void };
  try {
    if (typeof candidate.close === "function") {
      await candidate.close();
      return;
    }
    if (typeof candidate.destroy === "function") {
      candidate.destroy();
    }
  } catch {
    // ignore dispatcher cleanup errors
  }
}

export async function assertPublicHostname(
  hostname: string,
  lookupFn: LookupFn = dnsLookup,
): Promise<void> {
  await resolvePinnedHostname(hostname, lookupFn);
}
