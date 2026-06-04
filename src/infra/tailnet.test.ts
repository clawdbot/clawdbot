// Covers local tailnet address detection and primary selection.
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  isTailnetIPv4,
  listTailnetAddresses,
  pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6,
} from "./tailnet.js";

describe("tailnet helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects tailscale ipv4 ranges", () => {
    expect(isTailnetIPv4("100.64.0.1")).toBe(true);
    expect(isTailnetIPv4("100.127.255.254")).toBe(true);
    expect(isTailnetIPv4("100.63.255.255")).toBe(false);
    expect(isTailnetIPv4("192.168.1.10")).toBe(false);
  });

  it("lists unique non-internal tailnet addresses only", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(
      makeNetworkInterfacesSnapshot({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [
          { address: " 100.88.1.5 ", family: "IPv4" },
          { address: "100.88.1.5", family: "IPv4" },
          { address: "fd7a:115c:a1e0::1", family: "IPv6" },
          { address: " ", family: "IPv6" },
          { address: "fe80::1", family: "IPv6" },
        ],
      }),
    );

    expect(listTailnetAddresses()).toEqual({
      ipv4: ["100.88.1.5"],
      ipv6: ["fd7a:115c:a1e0::1"],
    });
  });

  it("picks the first available tailnet addresses", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(
      makeNetworkInterfacesSnapshot({
        utun1: [
          { address: "100.99.1.1", family: "IPv4" },
          { address: "100.99.1.2", family: "IPv4" },
          { address: "fd7a:115c:a1e0::9", family: "IPv6" },
        ],
      }),
    );

    expect(pickPrimaryTailnetIPv4()).toBe("100.99.1.1");
    expect(pickPrimaryTailnetIPv6()).toBe("fd7a:115c:a1e0::9");
  });

  it("throws when interface discovery fails", () => {
    vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses failed");
    });

    expect(() => listTailnetAddresses()).toThrow("uv_interface_addresses failed");
  });
});
