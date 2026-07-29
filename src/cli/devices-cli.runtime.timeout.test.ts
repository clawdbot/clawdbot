// Devices CLI runtime timeout tests cover device command timeout handling.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn(async () => ({ pending: [], paired: [] }));
vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
  }),
  callGateway: callGatewayMock,
  formatGatewayTransportErrorJson: () => undefined,
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_options: unknown, action: () => Promise<unknown>) => await action(),
}));

const devicesRuntime = await import("./devices-cli.runtime.js");

describe("devices CLI gateway timeout parsing", () => {
  beforeEach(() => {
    callGatewayMock.mockClear().mockResolvedValue({ pending: [], paired: [] });
  });

  it.each([
    ["list", () => devicesRuntime.runDevicesListCommand({ timeout: "10ms" })],
    ["remove", () => devicesRuntime.runDevicesRemoveCommand("device-1", { timeout: "10ms" })],
    [
      "clear",
      () => devicesRuntime.runDevicesClearCommand({ timeout: "10ms", yes: true, pending: true }),
    ],
    ["approve", () => devicesRuntime.runDevicesApproveCommand("req-1", { timeout: "10ms" })],
    ["reject", () => devicesRuntime.runDevicesRejectCommand("req-1", { timeout: "10ms" })],
    [
      "rotate",
      () =>
        devicesRuntime.runDevicesRotateCommand({
          timeout: "10ms",
          device: "device-1",
          role: "operator",
        }),
    ],
    [
      "revoke",
      () =>
        devicesRuntime.runDevicesRevokeCommand({
          timeout: "10ms",
          device: "device-1",
          role: "operator",
        }),
    ],
  ])("rejects malformed --timeout before gateway call for devices %s", async (_name, run) => {
    await expect(run()).rejects.toThrow(
      'Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "10ms".',
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("passes strict integer timeout values to device gateway calls", async () => {
    await devicesRuntime.runDevicesRejectCommand("req-1", { timeout: "15000" });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "device.pair.reject",
        timeoutMs: 15_000,
      }),
    );
  });
});
