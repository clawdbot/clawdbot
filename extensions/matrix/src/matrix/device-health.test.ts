import { describe, expect, it } from "vitest";
import { isOpenClawManagedMatrixDevice, summarizeMatrixDeviceHealth } from "./device-health.js";

describe("matrix device health", () => {
  it("detects OpenClaw-managed device names", () => {
    expect(isOpenClawManagedMatrixDevice("OpenClaw Gateway")).toBe(true);
    expect(isOpenClawManagedMatrixDevice("OpenClaw Debug")).toBe(true);
    expect(isOpenClawManagedMatrixDevice("Element iPhone")).toBe(false);
    expect(isOpenClawManagedMatrixDevice(null)).toBe(false);
  });

  it("summarizes stale OpenClaw-managed devices separately from the current device", () => {
    const summary = summarizeMatrixDeviceHealth([
      {
        deviceId: "du314Zpw3A",
        displayName: "OpenClaw Gateway",
        current: true,
      },
      {
        deviceId: "BritdXC6iL",
        displayName: "OpenClaw Gateway",
        current: false,
      },
      {
        deviceId: "G6NJU9cTgs",
        displayName: "OpenClaw Debug",
        current: false,
      },
      {
        deviceId: "phone123",
        displayName: "Element iPhone",
        current: false,
      },
    ]);

    expect(summary.currentDeviceId).toBe("du314Zpw3A");
    expect(summary.currentOpenClawDevices).toEqual([
      expect.objectContaining({ deviceId: "du314Zpw3A" }),
    ]);
    expect(summary.staleOpenClawDevices).toEqual([
      expect.objectContaining({ deviceId: "BritdXC6iL" }),
      expect.objectContaining({ deviceId: "G6NJU9cTgs" }),
    ]);
  });
});
