// Covers best-effort network discovery display helpers.
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  inspectBestEffortPrimaryTailnetIPv4,
  pickBestEffortPrimaryLanIPv4,
  resolveBestEffortGatewayBindHostForDisplay,
} from "./network-discovery-display.js";

const discoveryErrorMessage = "uv_interface_addresses failed";

function mockInterfaceDiscoveryFailure(): void {
  vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
    throw new Error(discoveryErrorMessage);
  });
}

describe("network display discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no LAN address when interface discovery throws", () => {
    mockInterfaceDiscoveryFailure();

    expect(pickBestEffortPrimaryLanIPv4()).toBeUndefined();
  });

  it("reports a warning when tailnet inspection throws", () => {
    mockInterfaceDiscoveryFailure();

    expect(
      inspectBestEffortPrimaryTailnetIPv4({
        warningPrefix: "Status could not inspect tailnet addresses",
      }),
    ).toEqual({
      tailnetIPv4: undefined,
      warning: `Status could not inspect tailnet addresses: ${discoveryErrorMessage}.`,
    });
  });

  it("falls back to loopback when bind host resolution throws", async () => {
    mockInterfaceDiscoveryFailure();

    await expect(
      resolveBestEffortGatewayBindHostForDisplay({
        bindMode: "tailnet",
        warningPrefix:
          "Status is using fallback network details because interface discovery failed",
      }),
    ).resolves.toEqual({
      bindHost: "127.0.0.1",
      warning: `Status is using fallback network details because interface discovery failed: ${discoveryErrorMessage}.`,
    });
  });

  it("still returns discovered tailnet values when interfaces are available", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(
      makeNetworkInterfacesSnapshot({
        utun9: [{ address: "100.88.1.5", family: "IPv4" }],
      }),
    );

    expect(inspectBestEffortPrimaryTailnetIPv4()).toEqual({
      tailnetIPv4: "100.88.1.5",
    });
  });
});
