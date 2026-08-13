import { describe, expect, it } from "vitest";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import { WorkerProviderError } from "../../plugins/types.js";
import { createDeviceWorkerProvider } from "./device-provider.js";

const DEVICE_ID = "device-session-host";

function pairedDevice(deviceId = DEVICE_ID): PairedDevice {
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    role: "node",
    roles: ["node"],
    tokens: {
      node: {
        token: "fixture-token",
        role: "node",
        scopes: [],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

describe("device worker provider", () => {
  it("provisions deterministic node leases only for connected paired session hosts", async () => {
    const provider = createDeviceWorkerProvider({
      getPairedDevice: async (deviceId) => pairedDevice(deviceId),
      listConnectedNodes: async () => [{ nodeId: DEVICE_ID, commands: ["system.run"] }],
    });

    const first = await provider.provision({ device: DEVICE_ID }, "operation-1");
    const repeated = await provider.provision({ device: DEVICE_ID }, "operation-1");
    const next = await provider.provision({ device: DEVICE_ID }, "operation-2");

    expect(first).toEqual({
      leaseId: expect.stringMatching(/^device:[a-f0-9]{64}:[a-f0-9]{32}$/u),
      node: { deviceId: DEVICE_ID },
      sharedHost: true,
    });
    expect(repeated.leaseId).toBe(first.leaseId);
    expect(next.leaseId).not.toBe(first.leaseId);
  });

  it.each([
    {
      name: "missing pairing",
      getPairedDevice: async () => null,
      listConnectedNodes: async () => [{ nodeId: DEVICE_ID, commands: ["system.run"] }],
    },
    {
      name: "offline device",
      getPairedDevice: async () => pairedDevice(),
      listConnectedNodes: async () => [],
    },
    {
      name: "connected node without session execution",
      getPairedDevice: async () => pairedDevice(),
      listConnectedNodes: async () => [{ nodeId: DEVICE_ID, commands: [] }],
    },
  ])("rejects $name during provision", async ({ getPairedDevice, listConnectedNodes }) => {
    const provider = createDeviceWorkerProvider({ getPairedDevice, listConnectedNodes });

    await expect(provider.provision({ device: DEVICE_ID }, "operation")).rejects.toBeInstanceOf(
      WorkerProviderError,
    );
  });

  it("reports active, dormant, and unknown from pairing plus live presence", async () => {
    let paired: PairedDevice | null = pairedDevice();
    let connected = true;
    const provider = createDeviceWorkerProvider({
      getPairedDevice: async () => paired,
      listConnectedNodes: async () =>
        connected ? [{ nodeId: DEVICE_ID, commands: ["system.run"] }] : [],
    });
    const lease = { leaseId: "device-lease", profile: { device: DEVICE_ID } };

    await expect(provider.inspect(lease)).resolves.toEqual({ status: "active", sharedHost: true });
    connected = false;
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "dormant" });
    paired = null;
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "unknown" });
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
  });
});
