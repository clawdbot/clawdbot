import { describe, expect, it } from "vitest";
import { blockedIpv6MulticastLiterals } from "./ip-test-fixtures.js";
import {
  extractEmbeddedIpv4FromIpv6,
  isBlockedSpecialUseIpv4Address,
  isBlockedSpecialUseIpv6Address,
  isCanonicalDottedDecimalIPv4,
  isCarrierGradeNatIpv4Address,
  isIpInCidr,
  isIpv4Address,
  isIpv6Address,
  isLegacyIpv4Literal,
  isLoopbackIpAddress,
  isPrivateOrLoopbackIpAddress,
  isRfc1918Ipv4Address,
  normalizeIpAddress,
  parseCanonicalIpAddress,
  parseLooseIpAddress,
} from "./ip.js";

describe("shared ip helpers", () => {
  it("distinguishes canonical dotted IPv4 from legacy forms", () => {
    expect(isCanonicalDottedDecimalIPv4("127.0.0.1")).toBe(true);
    expect(isCanonicalDottedDecimalIPv4("0177.0.0.1")).toBe(false);
    expect(isLegacyIpv4Literal("0177.0.0.1")).toBe(true);
    expect(isLegacyIpv4Literal("127.1")).toBe(true);
    expect(isLegacyIpv4Literal("example.com")).toBe(false);
  });

  it("matches both IPv4 and IPv6 CIDRs", () => {
    expect(isIpInCidr("10.42.0.59", "10.42.0.0/24")).toBe(true);
    expect(isIpInCidr("10.43.0.59", "10.42.0.0/24")).toBe(false);
    expect(isIpInCidr("2001:db8::1234", "2001:db8::/32")).toBe(true);
    expect(isIpInCidr("2001:db9::1234", "2001:db8::/32")).toBe(false);
    expect(isIpInCidr("::ffff:127.0.0.1", "127.0.0.1")).toBe(true);
    expect(isIpInCidr("127.0.0.1", "::ffff:127.0.0.2")).toBe(false);
  });

  it("extracts embedded IPv4 for transition prefixes", () => {
    const cases = [
      ["::ffff:127.0.0.1", "127.0.0.1"],
      ["::127.0.0.1", "127.0.0.1"],
      ["64:ff9b::8.8.8.8", "8.8.8.8"],
      ["64:ff9b:1::10.0.0.1", "10.0.0.1"],
      ["2002:0808:0808::", "8.8.8.8"],
      ["2001::f7f7:f7f7", "8.8.8.8"],
      ["2001:4860:1::5efe:7f00:1", "127.0.0.1"],
    ] as const;
    for (const [ipv6Literal, expectedIpv4] of cases) {
      const parsed = parseCanonicalIpAddress(ipv6Literal);
      expect(parsed?.kind(), ipv6Literal).toBe("ipv6");
      if (!parsed || !isIpv6Address(parsed)) {
        continue;
      }
      expect(extractEmbeddedIpv4FromIpv6(parsed)?.toString(), ipv6Literal).toBe(expectedIpv4);
    }
  });

  it("treats blocked IPv6 classes as private/internal", () => {
    expect(isPrivateOrLoopbackIpAddress("fec0::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("2001:db8::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("2001:2::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("100::1")).toBe(true);
    expect(isPrivateOrLoopbackIpAddress("2001:20::1")).toBe(true);
    for (const literal of blockedIpv6MulticastLiterals) {
      expect(isPrivateOrLoopbackIpAddress(literal)).toBe(true);
    }
    expect(isPrivateOrLoopbackIpAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("normalizes canonical IP strings and loopback detection", () => {
    expect(normalizeIpAddress("[::FFFF:127.0.0.1]")).toBe("127.0.0.1");
    expect(normalizeIpAddress("  [2001:DB8::1]  ")).toBe("2001:db8::1");
    expect(isLoopbackIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIpAddress("198.18.0.1")).toBe(false);
  });

  it("parses loose legacy IPv4 literals that canonical parsing rejects", () => {
    expect(parseCanonicalIpAddress("0177.0.0.1")).toBeUndefined();
    expect(parseLooseIpAddress("0177.0.0.1")?.toString()).toBe("127.0.0.1");
    expect(parseLooseIpAddress("[::1]")?.toString()).toBe("::1");
  });

  it("classifies RFC1918 and carrier-grade-nat IPv4 ranges", () => {
    expect(isRfc1918Ipv4Address("10.42.0.59")).toBe(true);
    expect(isRfc1918Ipv4Address("100.64.0.1")).toBe(false);
    expect(isCarrierGradeNatIpv4Address("100.64.0.1")).toBe(true);
    expect(isCarrierGradeNatIpv4Address("10.42.0.59")).toBe(false);
  });

  it("blocks special-use IPv4 ranges while allowing optional RFC2544 benchmark addresses", () => {
    const loopback = parseCanonicalIpAddress("127.0.0.1");
    const benchmark = parseCanonicalIpAddress("198.18.0.1");

    expect(loopback?.kind()).toBe("ipv4");
    expect(benchmark?.kind()).toBe("ipv4");
    if (!loopback || !isIpv4Address(loopback) || !benchmark || !isIpv4Address(benchmark)) {
      throw new Error("expected ipv4 fixtures");
    }

    expect(isBlockedSpecialUseIpv4Address(loopback)).toBe(true);
    expect(isBlockedSpecialUseIpv4Address(benchmark)).toBe(true);
    expect(isBlockedSpecialUseIpv4Address(benchmark, { allowRfc2544BenchmarkRange: true })).toBe(
      false,
    );
  });

  it("blocks IPv6 unique-local addresses by default and exempts them on opt-in (#74351)", () => {
    // fc00::/7 is the IPv6 ULA range. Sing-box / Clash / Surge fake-ip
    // proxies resolve foreign domains here, alongside the IPv4 198.18.0.0/15
    // benchmark range. Operators using those proxies need both ranges
    // exempted to keep web_fetch working.
    const ula = parseCanonicalIpAddress("fc00::1");
    expect(ula?.kind()).toBe("ipv6");
    if (!ula || !isIpv6Address(ula)) {
      throw new Error("expected ipv6 fixture");
    }

    // Default policy (no options) must continue to block the ULA range.
    expect(isBlockedSpecialUseIpv6Address(ula)).toBe(true);
    expect(isBlockedSpecialUseIpv6Address(ula, {})).toBe(true);
    expect(isBlockedSpecialUseIpv6Address(ula, { allowUniqueLocalRange: false })).toBe(true);

    // Opt-in flag — the only path the SSRF policy uses to thread fake-ip
    // proxy intent through to the address classifier.
    expect(isBlockedSpecialUseIpv6Address(ula, { allowUniqueLocalRange: true })).toBe(false);
  });

  it("opt-in unique-local exemption does NOT bleed into other special-use IPv6 ranges (#74351)", () => {
    // The exemption must be scoped: loopback (::1), unspecified (::), and
    // multicast (ff00::/8) all stay blocked even when `allowUniqueLocalRange`
    // is set, otherwise the flag silently widens the SSRF escape hatch
    // beyond what operators opted into.
    const loopback = parseCanonicalIpAddress("::1");
    const multicast = parseCanonicalIpAddress("ff02::1");
    const siteLocal = parseCanonicalIpAddress("fec0::1"); // deprecated fec0::/10

    if (
      !loopback ||
      !isIpv6Address(loopback) ||
      !multicast ||
      !isIpv6Address(multicast) ||
      !siteLocal ||
      !isIpv6Address(siteLocal)
    ) {
      throw new Error("expected ipv6 fixtures");
    }

    for (const options of [{}, { allowUniqueLocalRange: true }] as const) {
      expect(isBlockedSpecialUseIpv6Address(loopback, options)).toBe(true);
      expect(isBlockedSpecialUseIpv6Address(multicast, options)).toBe(true);
      expect(isBlockedSpecialUseIpv6Address(siteLocal, options)).toBe(true);
    }
  });
});
