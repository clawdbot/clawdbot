import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { WorkerProviderError } from "../../plugins/types.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { createDeviceWorkerRuntime } from "./device-provider.js";

const DEVICE_ID = "device-session-host";
const WORKER_BUILD = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.12",
  protocolFeatures: ["worker-heartbeat-v1"],
};

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

function connectedNode(
  deviceId = DEVICE_ID,
  workerRuns: NodeWorkerSupervisorNodeProof["workerRuns"] | null = WORKER_BUILD,
): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: deviceId,
    connId: `conn-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    commands: ["system.run"],
    ...(workerRuns ? { workerRuns } : {}),
  };
}

function deviceRuntime(params: {
  getPairedDevice: (deviceId: string) => Promise<PairedDevice | null>;
  listCurrentNodes?: () => Promise<readonly NodeWorkerSupervisorNodeProof[]>;
}) {
  const runtime = createDeviceWorkerRuntime({ getPairedDevice: params.getPairedDevice });
  if (params.listCurrentNodes) {
    runtime.bindNodeTransport({
      listCurrentNodes: params.listCurrentNodes,
      invoke: async () => ({ ok: false }),
    });
  }
  return runtime;
}

describe("device worker provider", () => {
  it("provisions deterministic node leases only for connected paired session hosts", async () => {
    const provider = deviceRuntime({
      getPairedDevice: async (deviceId) => pairedDevice(deviceId),
      listCurrentNodes: async () => [connectedNode()],
    }).provider;

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
      listCurrentNodes: async () => [connectedNode()],
    },
    {
      name: "offline device",
      getPairedDevice: async () => pairedDevice(),
      listCurrentNodes: async () => [],
    },
    {
      name: "connected node without worker session hosting",
      getPairedDevice: async () => pairedDevice(),
      listCurrentNodes: async () => [connectedNode(DEVICE_ID, null)],
    },
  ])("rejects $name during provision", async ({ getPairedDevice, listCurrentNodes }) => {
    const provider = deviceRuntime({ getPairedDevice, listCurrentNodes }).provider;

    await expect(provider.provision({ device: DEVICE_ID }, "operation")).rejects.toBeInstanceOf(
      WorkerProviderError,
    );
  });

  it("reports active, dormant, and unknown from pairing plus live presence", async () => {
    let paired: PairedDevice | null = pairedDevice();
    let connected = true;
    const runtime = deviceRuntime({
      getPairedDevice: async () => paired,
      listCurrentNodes: async () => (connected ? [connectedNode()] : []),
    });
    const provider = runtime.provider;
    const lease = { leaseId: "device-lease", profile: { device: DEVICE_ID } };

    await expect(provider.inspect(lease)).resolves.toEqual({ status: "active", sharedHost: true });
    connected = false;
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "dormant" });
    paired = null;
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "unknown" });
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
  });
});
