import { describe, expect, it } from "vitest";

import { isTrustedProxyAddress, resolveGatewayListenHosts } from "./net.js";

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
  describe("exact IP matching (backward compatibility)", () => {
    it("matches exact IP addresses", () => {
      expect(isTrustedProxyAddress("10.0.0.1", ["10.0.0.1"])).toBe(true);
      expect(isTrustedProxyAddress("10.0.0.1", ["10.0.0.2"])).toBe(false);
      expect(isTrustedProxyAddress("192.168.1.1", ["192.168.1.1", "10.0.0.1"])).toBe(true);
    });

    it("returns false when trustedProxies is empty or undefined", () => {
      expect(isTrustedProxyAddress("10.0.0.1", [])).toBe(false);
      expect(isTrustedProxyAddress("10.0.0.1", undefined)).toBe(false);
    });

    it("returns false when IP is undefined", () => {
      expect(isTrustedProxyAddress(undefined, ["10.0.0.1"])).toBe(false);
    });
  });

  describe("CIDR notation support", () => {
    it("matches IPs within /8 CIDR range", () => {
      expect(isTrustedProxyAddress("10.0.0.1", ["10.0.0.0/8"])).toBe(true);
      expect(isTrustedProxyAddress("10.17.42.3", ["10.0.0.0/8"])).toBe(true);
      expect(isTrustedProxyAddress("10.255.255.255", ["10.0.0.0/8"])).toBe(true);
      expect(isTrustedProxyAddress("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
      expect(isTrustedProxyAddress("192.168.1.1", ["10.0.0.0/8"])).toBe(false);
    });

    it("matches IPs within /12 CIDR range", () => {
      expect(isTrustedProxyAddress("172.16.0.1", ["172.16.0.0/12"])).toBe(true);
      expect(isTrustedProxyAddress("172.31.255.255", ["172.16.0.0/12"])).toBe(true);
      expect(isTrustedProxyAddress("172.15.255.255", ["172.16.0.0/12"])).toBe(false);
      expect(isTrustedProxyAddress("172.32.0.1", ["172.16.0.0/12"])).toBe(false);
    });

    it("matches IPs within /16 CIDR range", () => {
      expect(isTrustedProxyAddress("192.168.0.1", ["192.168.0.0/16"])).toBe(true);
      expect(isTrustedProxyAddress("192.168.255.255", ["192.168.0.0/16"])).toBe(true);
      expect(isTrustedProxyAddress("192.169.0.1", ["192.168.0.0/16"])).toBe(false);
    });

    it("handles multiple CIDR ranges", () => {
      const trustedProxies = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
      expect(isTrustedProxyAddress("10.17.42.3", trustedProxies)).toBe(true);
      expect(isTrustedProxyAddress("172.16.0.1", trustedProxies)).toBe(true);
      expect(isTrustedProxyAddress("192.168.1.1", trustedProxies)).toBe(true);
      expect(isTrustedProxyAddress("8.8.8.8", trustedProxies)).toBe(false);
    });

    it("handles mixed exact IPs and CIDR ranges", () => {
      const trustedProxies = ["10.0.0.0/8", "192.168.1.100"];
      expect(isTrustedProxyAddress("10.17.42.3", trustedProxies)).toBe(true);
      expect(isTrustedProxyAddress("192.168.1.100", trustedProxies)).toBe(true);
      expect(isTrustedProxyAddress("192.168.1.101", trustedProxies)).toBe(false);
    });

    it("handles edge cases", () => {
      expect(isTrustedProxyAddress("0.0.0.0", ["0.0.0.0/0"])).toBe(true);
      expect(isTrustedProxyAddress("255.255.255.255", ["0.0.0.0/0"])).toBe(true);
      expect(isTrustedProxyAddress("10.0.0.1", ["10.0.0.0/32"])).toBe(false);
      expect(isTrustedProxyAddress("10.0.0.0", ["10.0.0.0/32"])).toBe(true);
    });

    it("handles invalid CIDR gracefully", () => {
      // Invalid prefix length should fall back to exact match
      expect(isTrustedProxyAddress("10.0.0.0", ["10.0.0.0/33"])).toBe(true);
      expect(isTrustedProxyAddress("10.0.0.1", ["10.0.0.0/33"])).toBe(false);
      expect(isTrustedProxyAddress("10.0.0.0", ["10.0.0.0/-1"])).toBe(true);
    });
  });

  describe("normalization", () => {
    it("handles IPv4-mapped IPv6 addresses", () => {
      expect(isTrustedProxyAddress("::ffff:10.0.0.1", ["10.0.0.0/8"])).toBe(true);
      expect(isTrustedProxyAddress("::ffff:192.168.1.1", ["192.168.0.0/16"])).toBe(true);
    });

    it("handles case-insensitive IPs", () => {
      expect(isTrustedProxyAddress("10.0.0.1", ["10.0.0.0/8"])).toBe(true);
      // IPv4 addresses don't have case, but normalization should still work
    });
  });
});
