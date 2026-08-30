// Covers local tailnet address detection and primary selection.
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import { isTailnetIPv4, pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "./tailnet.js";

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
});
