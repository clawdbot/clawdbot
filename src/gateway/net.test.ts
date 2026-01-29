import { describe, expect, it } from "vitest";

import { isTrustedProxyAddress, resolveGatewayClientIp, resolveGatewayListenHosts } from "./net.js";

describe("resolveGatewayListenHosts", () => {
  it("returns the input host when not loopback", async () => {
    const hosts = await resolveGatewayListenHosts("0.0.0.0", {
      canBindToHost: async () => {
        throw new Error("should not be called");
      },
    });
    expect(hosts).toEqual(["0.0.0.0"]);
  });

  it("adds ::1 when IPv6 loopback is available", async () => {
    const hosts = await resolveGatewayListenHosts("127.0.0.1", {
      canBindToHost: async () => true,
    });
    expect(hosts).toEqual(["127.0.0.1", "::1"]);
  });

  it("keeps only IPv4 loopback when IPv6 is unavailable", async () => {
    const hosts = await resolveGatewayListenHosts("127.0.0.1", {
      canBindToHost: async () => false,
    });
    expect(hosts).toEqual(["127.0.0.1"]);
  });
});

describe("isTrustedProxyAddress", () => {
  describe("exact IP matching", () => {
    it("returns false for undefined IP", () => {
      expect(isTrustedProxyAddress(undefined, ["1.2.3.4"])).toBe(false);
    });

    it("returns false for empty trusted proxies", () => {
      expect(isTrustedProxyAddress("1.2.3.4", [])).toBe(false);
    });

    it("returns false for undefined trusted proxies", () => {
      expect(isTrustedProxyAddress("1.2.3.4", undefined)).toBe(false);
    });

    it("matches exact IPv4 address", () => {
      expect(isTrustedProxyAddress("192.168.1.1", ["192.168.1.1"])).toBe(true);
    });

    it("rejects non-matching IPv4 address", () => {
      expect(isTrustedProxyAddress("192.168.1.2", ["192.168.1.1"])).toBe(false);
    });

    it("normalizes IPv4-mapped IPv6 addresses", () => {
      expect(isTrustedProxyAddress("::ffff:192.168.1.1", ["192.168.1.1"])).toBe(true);
    });
  });

  describe("IPv4 CIDR matching", () => {
    it("matches IP within /24 subnet", () => {
      expect(isTrustedProxyAddress("192.168.1.50", ["192.168.1.0/24"])).toBe(true);
    });

    it("rejects IP outside /24 subnet", () => {
      expect(isTrustedProxyAddress("192.168.2.50", ["192.168.1.0/24"])).toBe(false);
    });

    it("matches IP within /20 subnet", () => {
      // 188.114.96.0/20 covers 188.114.96.0 - 188.114.111.255
      expect(isTrustedProxyAddress("188.114.96.1", ["188.114.96.0/20"])).toBe(true);
      expect(isTrustedProxyAddress("188.114.111.255", ["188.114.96.0/20"])).toBe(true);
      expect(isTrustedProxyAddress("188.114.100.50", ["188.114.96.0/20"])).toBe(true);
    });

    it("rejects IP outside /20 subnet", () => {
      expect(isTrustedProxyAddress("188.114.112.1", ["188.114.96.0/20"])).toBe(false);
      expect(isTrustedProxyAddress("188.114.95.255", ["188.114.96.0/20"])).toBe(false);
    });

    it("matches IP within /22 subnet", () => {
      // 197.234.240.0/22 covers 197.234.240.0 - 197.234.243.255
      expect(isTrustedProxyAddress("197.234.240.1", ["197.234.240.0/22"])).toBe(true);
      expect(isTrustedProxyAddress("197.234.243.255", ["197.234.240.0/22"])).toBe(true);
    });

    it("rejects IP outside /22 subnet", () => {
      expect(isTrustedProxyAddress("197.234.244.0", ["197.234.240.0/22"])).toBe(false);
    });

    it("handles /32 as exact match", () => {
      expect(isTrustedProxyAddress("10.0.0.1", ["10.0.0.1/32"])).toBe(true);
      expect(isTrustedProxyAddress("10.0.0.2", ["10.0.0.1/32"])).toBe(false);
    });

    it("handles /0 as match all", () => {
      expect(isTrustedProxyAddress("1.2.3.4", ["0.0.0.0/0"])).toBe(true);
    });
  });

  describe("IPv6 CIDR matching", () => {
    it("matches IP within /64 subnet", () => {
      expect(isTrustedProxyAddress("2001:db8::1", ["2001:db8::/64"])).toBe(true);
      expect(isTrustedProxyAddress("2001:db8::ffff", ["2001:db8::/64"])).toBe(true);
    });

    it("rejects IP outside /64 subnet", () => {
      expect(isTrustedProxyAddress("2001:db9::1", ["2001:db8::/64"])).toBe(false);
    });

    it("matches IP within /48 subnet", () => {
      // /48 means first 48 bits (3 groups) must match
      expect(isTrustedProxyAddress("2400:cb00:0:1::1", ["2400:cb00::/48"])).toBe(true);
      expect(isTrustedProxyAddress("2400:cb00:0:ffff:eeee::1", ["2400:cb00::/48"])).toBe(true);
    });

    it("rejects IP outside /48 subnet", () => {
      // Third group differs (0001 vs 0000)
      expect(isTrustedProxyAddress("2400:cb00:1:2::1", ["2400:cb00::/48"])).toBe(false);
    });

    it("handles /128 as exact match", () => {
      expect(isTrustedProxyAddress("::1", ["::1/128"])).toBe(true);
      expect(isTrustedProxyAddress("::2", ["::1/128"])).toBe(false);
    });
  });

  describe("mixed trusted proxies list", () => {
    it("matches against multiple CIDRs and exact IPs", () => {
      const trustedProxies = ["188.114.96.0/20", "197.234.240.0/22", "10.0.0.1"];
      expect(isTrustedProxyAddress("188.114.100.50", trustedProxies)).toBe(true);
      expect(isTrustedProxyAddress("197.234.241.1", trustedProxies)).toBe(true);
      expect(isTrustedProxyAddress("10.0.0.1", trustedProxies)).toBe(true);
      expect(isTrustedProxyAddress("1.2.3.4", trustedProxies)).toBe(false);
    });
  });
});

describe("resolveGatewayClientIp", () => {
  describe("direct connection (no proxy)", () => {
    it("returns remoteAddr when no trusted proxies configured", () => {
      expect(
        resolveGatewayClientIp({
          remoteAddr: "203.0.113.10",
          forwardedFor: "192.168.1.1",
        }),
      ).toBe("203.0.113.10");
    });

    it("returns remoteAddr when not from trusted proxy", () => {
      expect(
        resolveGatewayClientIp({
          remoteAddr: "203.0.113.10",
          forwardedFor: "192.168.1.1",
          trustedProxies: ["10.0.0.0/8"],
        }),
      ).toBe("203.0.113.10");
    });
  });

  describe("single proxy", () => {
    it("returns X-Forwarded-For client when direct connection is from trusted proxy", () => {
      expect(
        resolveGatewayClientIp({
          remoteAddr: "10.0.0.1",
          forwardedFor: "203.0.113.10",
          trustedProxies: ["10.0.0.0/8"],
        }),
      ).toBe("203.0.113.10");
    });

    it("uses X-Real-IP as fallback", () => {
      expect(
        resolveGatewayClientIp({
          remoteAddr: "10.0.0.1",
          realIp: "203.0.113.10",
          trustedProxies: ["10.0.0.0/8"],
        }),
      ).toBe("203.0.113.10");
    });
  });

  describe("multi-proxy chain (e.g., Client → Cloudflare → nginx)", () => {
    // Cloudflare IPs: 188.114.96.0/20
    // Local nginx: 10.0.0.1
    const trustedProxies = ["188.114.96.0/20", "10.0.0.1"];

    it("returns real client when all proxies are trusted", () => {
      // Client → Cloudflare (188.114.100.1) → nginx (10.0.0.1)
      // XFF: "203.0.113.10, 188.114.100.1"
      expect(
        resolveGatewayClientIp({
          remoteAddr: "10.0.0.1",
          forwardedFor: "203.0.113.10, 188.114.100.1",
          trustedProxies,
        }),
      ).toBe("203.0.113.10");
    });

    it("stops at first untrusted proxy in chain", () => {
      // Client → Unknown proxy (1.2.3.4) → Cloudflare → nginx
      // XFF: "203.0.113.10, 1.2.3.4, 188.114.100.1"
      // Should return 1.2.3.4 (first untrusted from right)
      expect(
        resolveGatewayClientIp({
          remoteAddr: "10.0.0.1",
          forwardedFor: "203.0.113.10, 1.2.3.4, 188.114.100.1",
          trustedProxies,
        }),
      ).toBe("1.2.3.4");
    });

    it("handles single IP in X-Forwarded-For", () => {
      expect(
        resolveGatewayClientIp({
          remoteAddr: "10.0.0.1",
          forwardedFor: "203.0.113.10",
          trustedProxies,
        }),
      ).toBe("203.0.113.10");
    });

    it("handles spaces in X-Forwarded-For", () => {
      expect(
        resolveGatewayClientIp({
          remoteAddr: "10.0.0.1",
          forwardedFor: "  203.0.113.10  ,  188.114.100.1  ",
          trustedProxies,
        }),
      ).toBe("203.0.113.10");
    });

    it("falls back to leftmost IP when all XFF entries are trusted", () => {
      // All proxies trusted, return the leftmost (original client position)
      expect(
        resolveGatewayClientIp({
          remoteAddr: "10.0.0.1",
          forwardedFor: "188.114.100.1, 188.114.100.2",
          trustedProxies,
        }),
      ).toBe("188.114.100.1");
    });
  });

  describe("CIDR-based proxy chain", () => {
    // Example: trusting entire Cloudflare IPv4 ranges
    const cloudflareRanges = [
      "173.245.48.0/20",
      "103.21.244.0/22",
      "103.22.200.0/22",
      "103.31.4.0/22",
      "141.101.64.0/18",
      "108.162.192.0/18",
      "190.93.240.0/20",
      "188.114.96.0/20",
      "197.234.240.0/22",
      "198.41.128.0/17",
      "127.0.0.0/8", // local proxy
    ];

    it("resolves client IP through Cloudflare proxy chain", () => {
      expect(
        resolveGatewayClientIp({
          remoteAddr: "127.0.0.1",
          forwardedFor: "203.0.113.42, 188.114.100.50",
          trustedProxies: cloudflareRanges,
        }),
      ).toBe("203.0.113.42");
    });
  });
});
