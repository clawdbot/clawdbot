// Network Policy module implements ip behavior.
import ipaddr from "ipaddr.js";

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Parsed IP address value returned by the net-policy parsing helpers. */
export type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;
type Ipv4Range = ReturnType<ipaddr.IPv4["range"]>;
type Ipv6Range = ReturnType<ipaddr.IPv6["range"]>;
// Older co-installed ipaddr.js declarations can merge with 2.4's ambient module and
// omit newer runtime ranges from ReturnType, so preserve the policy's known labels.
type BlockedIpv6Range = Ipv6Range | "benchmarking" | "discard" | "orchid2";
type Ipv6Hextets = readonly [number, number, number, number, number, number, number, number];

// ipaddr.js guarantees 8 hextets; throw loudly on an impossible shape instead of
// failing open (a silent undefined here would skip SSRF embedded-IPv4 blocking).
function expectIpv6Hextets(parts: readonly number[]): Ipv6Hextets {
  const [a, b, c, d, e, f, g, h] = parts;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    f === undefined ||
    g === undefined ||
    h === undefined
  ) {
    throw new Error("expected IPv6 address to expose 8 hextets");
  }
  return [a, b, c, d, e, f, g, h];
}

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
const CLOUD_METADATA_IP_ADDRESSES = new Set(["100.100.100.200", "fd00:ec2::254"]);
/** Per-call exemptions for `isBlockedSpecialUseIpv4Address`. */
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

function stripIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

function isNumericIpv4LiteralPart(value: string): boolean {
  return /^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
}

/** Type guard for parsed IPv4 addresses. */
export function isIpv4Address(address: ParsedIpAddress): address is ipaddr.IPv4 {
  return address.kind() === "ipv4";
}

/** Type guard for parsed IPv6 addresses. */
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

/** Parses canonical IPv4/IPv6 literals, rejecting legacy IPv4 shorthand forms. */
export function parseCanonicalIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) {
    return undefined;
  }
  const isCanonical =
    ipaddr.IPv4.isValidFourPartDecimal(normalized) || ipaddr.IPv6.isValid(normalized);
  return isCanonical ? ipaddr.parse(normalized) : undefined;
}

/** Parses canonical IP literals plus legacy IPv4 forms needed for SSRF checks. */
export function parseLooseIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) {
    return undefined;
  }
  return ipaddr.isValid(normalized) ? ipaddr.parse(normalized) : undefined;
}

/** Normalizes canonical IP literals and maps IPv4-mapped IPv6 addresses to IPv4 text. */
export function normalizeIpAddress(raw: string | undefined): string | undefined {
  const parsed = parseCanonicalIpAddress(raw);
  if (!parsed) {
    return undefined;
  }
  const normalized = normalizeIpv4MappedAddress(parsed);
  return normalizeLowercaseStringOrEmpty(normalized.toString());
}

/** True only for canonical four-part dotted-decimal IPv4 literals. */
export function isCanonicalDottedDecimalIPv4(raw: string | undefined): boolean {
  const normalized = normalizeIpParseInput(raw);
  return normalized !== undefined && ipaddr.IPv4.isValidFourPartDecimal(normalized);
}

/** Detects legacy numeric IPv4 forms that canonical parsing deliberately rejects. */
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

/** True when a canonical IP literal is loopback, including IPv4-mapped IPv6. */
export function isLoopbackIpAddress(raw: string | undefined): boolean {
  const parsed = parseCanonicalIpAddress(raw);
  if (!parsed) {
    return false;
  }
  const normalized = normalizeIpv4MappedAddress(parsed);
  return normalized.range() === "loopback";
}

/** True for link-local IPs, including legacy and embedded-IPv4 forms. */
export function isLinkLocalIpAddress(raw: string | undefined): boolean {
  const parsed = parseLooseIpAddress(raw);
  if (!parsed) {
    return false;
  }
  const normalized = normalizeIpv4MappedAddress(parsed);
  if (isIpv4Address(normalized)) {
    return normalized.range() === "linkLocal";
  }
  const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(normalized);
  if (embeddedIpv4?.range() === "linkLocal") {
    return true;
  }
  return normalized.range() === "linkLocal";
}

/** True for cloud metadata IP literals, including mapped and embedded forms. */
export function isCloudMetadataIpAddress(raw: string | undefined): boolean {
  const parsed = parseLooseIpAddress(raw);
  if (!parsed) {
    return false;
  }
  const normalized = normalizeIpv4MappedAddress(parsed);
  if (isIpv6Address(normalized)) {
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(normalized);
    if (embeddedIpv4 && CLOUD_METADATA_IP_ADDRESSES.has(embeddedIpv4.toString())) {
      return true;
    }
  }
  return CLOUD_METADATA_IP_ADDRESSES.has(normalized.toString());
}

/** True for canonical private, loopback, link-local, or blocked special-use IPs. */
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

/** Applies the SSRF block policy for parsed IPv6 special-use ranges. */
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
  const [firstPart] = expectIpv6Hextets(address.parts);
  return (firstPart & 0xffc0) === 0xfec0;
}

/** True for canonical IPv4 literals in RFC 1918 private ranges. */
export function isRfc1918Ipv4Address(raw: string | undefined): boolean {
  return parseCanonicalIpAddress(raw)?.range() === "private";
}

/** True for canonical IPv4 literals in the carrier-grade NAT range. */
export function isCarrierGradeNatIpv4Address(raw: string | undefined): boolean {
  return parseCanonicalIpAddress(raw)?.range() === "carrierGradeNat";
}

/** Applies the SSRF block policy for parsed IPv4 special-use ranges. */
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

/** Extracts embedded IPv4 addresses from mapped and transition IPv6 prefixes. */
export function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  const parts = expectIpv6Hextets(address.parts);
  switch (address.range()) {
    case "ipv4Mapped":
      return address.toIPv4Address();
    case "rfc6145":
    case "rfc6052":
      return decodeIpv4FromHextets(parts[6], parts[7]);
    case "6to4":
      return decodeIpv4FromHextets(parts[1], parts[2]);
    case "teredo":
      return decodeIpv4FromHextets(parts[6] ^ 0xffff, parts[7] ^ 0xffff);
    default:
      break;
  }

  // ipaddr.js classifies transition prefixes, but not compatible or ISATAP forms.
  const isIpv4Compatible =
    parts[0] === 0 &&
    parts[1] === 0 &&
    parts[2] === 0 &&
    parts[3] === 0 &&
    parts[4] === 0 &&
    parts[5] === 0;
  const isIsatap = (parts[4] & 0xfcff) === 0 && parts[5] === 0x5efe;
  if (isIpv4Compatible || isIsatap) {
    return decodeIpv4FromHextets(parts[6], parts[7]);
  }
  return undefined;
}

/** Checks an IP literal against an exact IP or CIDR range, normalizing mapped IPv4. */
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

  try {
    const [baseAddress, prefixLength] = ipaddr.parseCIDR(candidate);
    const comparableBase = normalizeIpv4MappedAddress(baseAddress);
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
