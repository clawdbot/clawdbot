import ipaddr from "ipaddr.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.js";

export type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;
type Ipv4Range = ReturnType<ipaddr.IPv4["range"]>;
type Ipv6Range = ReturnType<ipaddr.IPv6["range"]>;
type BlockedIpv6Range = Ipv6Range | "discard";

const BLOCKED_IPV4_SPECIAL_USE_RANGES = new Set<Ipv4Range>([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "carrierGradeNat",
  "private",
  "reserved",
]);

const PRIVATE_OR_LOOPBACK_IPV4_RANGES = new Set<Ipv4Range>([
  "loopback",
  "private",
  "linkLocal",
  "carrierGradeNat",
]);

const BLOCKED_IPV6_SPECIAL_USE_RANGES = new Set<BlockedIpv6Range>([
  "unspecified",
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "multicast",
  "reserved",
  "benchmarking",
  "discard",
  "orchid2",
]);
const RFC2544_BENCHMARK_PREFIX: [ipaddr.IPv4, number] = [ipaddr.IPv4.parse("198.18.0.0"), 15];
export type Ipv4SpecialUseBlockOptions = {
  allowRfc2544BenchmarkRange?: boolean;
};

/**
 * Per-call exemptions for `isBlockedSpecialUseIpv6Address`. Mirror of
 * {@link Ipv4SpecialUseBlockOptions} for the IPv6 side. Currently only
 * `allowUniqueLocalRange` is exposed (#74351); other reserved IPv6 ranges stay
 * unconditionally blocked because they have no documented fake-ip / proxy
 * use case.
 */
export type Ipv6SpecialUseBlockOptions = {
  /**
   * When true, exempt addresses in `fc00::/7` (the IPv6 Unique Local Address
   * block, RFC 4193) from the SSRF private-IP block. Sing-box / Clash / Surge
   * fake-ip implementations resolve foreign domains to ULA addresses
   * alongside RFC 2544 benchmark IPv4 addresses, and operators using those
   * proxy stacks need both ranges exempted to keep `web_fetch` working.
   */
  allowUniqueLocalRange?: boolean;
};

const EMBEDDED_IPV4_SENTINEL_RULES: Array<{
  matches: (parts: number[]) => boolean;
  toHextets: (parts: number[]) => [high: number, low: number];
}> = [
  {
    // IPv4-compatible form ::w.x.y.z (deprecated, but still seen in parser edge-cases).
    matches: (parts) =>
      parts[0] === 0 &&
      parts[1] === 0 &&
      parts[2] === 0 &&
      parts[3] === 0 &&
      parts[4] === 0 &&
      parts[5] === 0,
    toHextets: (parts) => [parts[6], parts[7]],
  },
  {
    // NAT64 local-use prefix: 64:ff9b:1::/48.
    matches: (parts) =>
      parts[0] === 0x0064 &&
      parts[1] === 0xff9b &&
      parts[2] === 0x0001 &&
      parts[3] === 0 &&
      parts[4] === 0 &&
      parts[5] === 0,
    toHextets: (parts) => [parts[6], parts[7]],
  },
  {
    // 6to4 prefix: 2002::/16 (IPv4 lives in hextets 1..2).
    matches: (parts) => parts[0] === 0x2002,
    toHextets: (parts) => [parts[1], parts[2]],
  },
  {
    // Teredo prefix: 2001:0000::/32 (client IPv4 XOR 0xffff in hextets 6..7).
    matches: (parts) => parts[0] === 0x2001 && parts[1] === 0x0000,
    toHextets: (parts) => [parts[6] ^ 0xffff, parts[7] ^ 0xffff],
  },
  {
    // ISATAP IID marker: ....:0000:5efe:w.x.y.z with u/g bits allowed in hextet 4.
    matches: (parts) => (parts[4] & 0xfcff) === 0 && parts[5] === 0x5efe,
    toHextets: (parts) => [parts[6], parts[7]],
  },
];

function stripIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

function isNumericIpv4LiteralPart(value: string): boolean {
  return /^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
}

function parseIpv6WithEmbeddedIpv4(raw: string): ipaddr.IPv6 | undefined {
  if (!raw.includes(":") || !raw.includes(".")) {
    return undefined;
  }
  const match = /^(.*:)([^:%]+(?:\.[^:%]+){3})(%[0-9A-Za-z]+)?$/i.exec(raw);
  if (!match) {
    return undefined;
  }
  const [, prefix, embeddedIpv4, zoneSuffix = ""] = match;
  if (!ipaddr.IPv4.isValidFourPartDecimal(embeddedIpv4)) {
    return undefined;
  }
  const octets = embeddedIpv4.split(".").map((part) => Number.parseInt(part, 10));
  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  const normalizedIpv6 = `${prefix}${high}:${low}${zoneSuffix}`;
  if (!ipaddr.IPv6.isValid(normalizedIpv6)) {
    return undefined;
  }
  return ipaddr.IPv6.parse(normalizedIpv6);
}

export function isIpv4Address(address: ParsedIpAddress): address is ipaddr.IPv4 {
  return address.kind() === "ipv4";
}

export function isIpv6Address(address: ParsedIpAddress): address is ipaddr.IPv6 {
  return address.kind() === "ipv6";
}

function normalizeIpv4MappedAddress(address: ParsedIpAddress): ParsedIpAddress {
  if (!isIpv6Address(address)) {
    return address;
  }
  if (!address.isIPv4MappedAddress()) {
    return address;
  }
  return address.toIPv4Address();
}

function normalizeIpParseInput(raw: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  return stripIpv6Brackets(trimmed);
}

export function parseCanonicalIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) {
    return undefined;
  }
  if (ipaddr.IPv4.isValid(normalized)) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(normalized)) {
      return undefined;
    }
    return ipaddr.IPv4.parse(normalized);
  }
  if (ipaddr.IPv6.isValid(normalized)) {
    return ipaddr.IPv6.parse(normalized);
  }
  return parseIpv6WithEmbeddedIpv4(normalized);
}

export function parseLooseIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) {
    return undefined;
  }
  if (ipaddr.isValid(normalized)) {
    return ipaddr.parse(normalized);
  }
  return parseIpv6WithEmbeddedIpv4(normalized);
}

export function normalizeIpAddress(raw: string | undefined): string | undefined {
  const parsed = parseCanonicalIpAddress(raw);
  if (!parsed) {
    return undefined;
  }
  const normalized = normalizeIpv4MappedAddress(parsed);
  return normalizeLowercaseStringOrEmpty(normalized.toString());
}

export function isCanonicalDottedDecimalIPv4(raw: string | undefined): boolean {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return false;
  }
  const normalized = stripIpv6Brackets(trimmed);
  if (!normalized) {
    return false;
  }
  return ipaddr.IPv4.isValidFourPartDecimal(normalized);
}

export function isLegacyIpv4Literal(raw: string | undefined): boolean {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return false;
  }
  const normalized = stripIpv6Brackets(trimmed);
  if (!normalized || normalized.includes(":")) {
    return false;
  }
  if (isCanonicalDottedDecimalIPv4(normalized)) {
    return false;
  }
  const parts = normalized.split(".");
  if (parts.length === 0 || parts.length > 4) {
    return false;
  }
  if (parts.some((part) => part.length === 0)) {
    return false;
  }
  if (!parts.every((part) => isNumericIpv4LiteralPart(part))) {
    return false;
  }
  return true;
}

export function isLoopbackIpAddress(raw: string | undefined): boolean {
  const parsed = parseCanonicalIpAddress(raw);
  if (!parsed) {
    return false;
  }
  const normalized = normalizeIpv4MappedAddress(parsed);
  return normalized.range() === "loopback";
}

export function isPrivateOrLoopbackIpAddress(raw: string | undefined): boolean {
  const parsed = parseCanonicalIpAddress(raw);
  if (!parsed) {
    return false;
  }
  const normalized = normalizeIpv4MappedAddress(parsed);
  if (isIpv4Address(normalized)) {
    return PRIVATE_OR_LOOPBACK_IPV4_RANGES.has(normalized.range());
  }
  return isBlockedSpecialUseIpv6Address(normalized);
}

export function isBlockedSpecialUseIpv6Address(
  address: ipaddr.IPv6,
  options: Ipv6SpecialUseBlockOptions = {},
): boolean {
  // ipaddr.js returns "discard" at runtime for 100::/64, but its published
  // TypeScript IPv6Range union omits that literal.
  const range = address.range() as BlockedIpv6Range;
  if (range === "uniqueLocal" && options.allowUniqueLocalRange === true) {
    // Operators running fake-ip proxy stacks (sing-box, Clash, Surge) opt in
    // to fc00::/7 reaching the network — same intent as
    // `allowRfc2544BenchmarkRange` for the IPv4 side (#74351).
    return false;
  }
  if (BLOCKED_IPV6_SPECIAL_USE_RANGES.has(range)) {
    return true;
  }
  // ipaddr.js does not classify deprecated site-local fec0::/10 as private.
  return (address.parts[0] & 0xffc0) === 0xfec0;
}

export function isRfc1918Ipv4Address(raw: string | undefined): boolean {
  const parsed = parseCanonicalIpAddress(raw);
  if (!parsed || !isIpv4Address(parsed)) {
    return false;
  }
  return parsed.range() === "private";
}

export function isCarrierGradeNatIpv4Address(raw: string | undefined): boolean {
  const parsed = parseCanonicalIpAddress(raw);
  if (!parsed || !isIpv4Address(parsed)) {
    return false;
  }
  return parsed.range() === "carrierGradeNat";
}

export function isBlockedSpecialUseIpv4Address(
  address: ipaddr.IPv4,
  options: Ipv4SpecialUseBlockOptions = {},
): boolean {
  const inRfc2544BenchmarkRange = address.match(RFC2544_BENCHMARK_PREFIX);
  if (inRfc2544BenchmarkRange && options.allowRfc2544BenchmarkRange === true) {
    return false;
  }
  return BLOCKED_IPV4_SPECIAL_USE_RANGES.has(address.range()) || inRfc2544BenchmarkRange;
}

function decodeIpv4FromHextets(high: number, low: number): ipaddr.IPv4 {
  const octets: [number, number, number, number] = [
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ];
  return ipaddr.IPv4.parse(octets.join("."));
}

export function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  if (address.isIPv4MappedAddress()) {
    return address.toIPv4Address();
  }
  if (address.range() === "rfc6145") {
    return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  }
  if (address.range() === "rfc6052") {
    return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  }
  for (const rule of EMBEDDED_IPV4_SENTINEL_RULES) {
    if (!rule.matches(address.parts)) {
      continue;
    }
    const [high, low] = rule.toHextets(address.parts);
    return decodeIpv4FromHextets(high, low);
  }
  return undefined;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const normalizedIp = parseCanonicalIpAddress(ip);
  if (!normalizedIp) {
    return false;
  }
  const candidate = cidr.trim();
  if (!candidate) {
    return false;
  }
  const comparableIp = normalizeIpv4MappedAddress(normalizedIp);
  if (!candidate.includes("/")) {
    const exact = parseCanonicalIpAddress(candidate);
    if (!exact) {
      return false;
    }
    const comparableExact = normalizeIpv4MappedAddress(exact);
    return (
      comparableIp.kind() === comparableExact.kind() &&
      comparableIp.toString() === comparableExact.toString()
    );
  }

  let parsedCidr: [ParsedIpAddress, number];
  try {
    parsedCidr = ipaddr.parseCIDR(candidate);
  } catch {
    return false;
  }

  const [baseAddress, prefixLength] = parsedCidr;
  const comparableBase = normalizeIpv4MappedAddress(baseAddress);
  if (comparableIp.kind() !== comparableBase.kind()) {
    return false;
  }
  try {
    if (isIpv4Address(comparableIp) && isIpv4Address(comparableBase)) {
      return comparableIp.match([comparableBase, prefixLength]);
    }
    if (isIpv6Address(comparableIp) && isIpv6Address(comparableBase)) {
      return comparableIp.match([comparableBase, prefixLength]);
    }
    return false;
  } catch {
    return false;
  }
}
