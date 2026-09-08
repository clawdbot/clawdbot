import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import { WorkerProviderError } from "../../plugins/types.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  bindDeviceWorkerReconciliation,
  createDeviceWorkerRuntime,
  reconcileDeviceWorker,
} from "./device-provider.js";

const DEVICE_ID = "device-session-host";
const DAY_MS = 24 * 60 * 60 * 1_000;
function pairedDevice(
  deviceId = DEVICE_ID,
  nodeSurface?: PairedDevice["nodeSurface"],
): PairedDevice {
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
    ...(nodeSurface ? { nodeSurface } : {}),
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

function connectedNode(deviceId = DEVICE_ID, available = true): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: deviceId,
    connId: `conn-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 2, available: available ? 2 : 0 } },
    commands: ["system.run"],
  };
}

function deviceRuntime(params: {
  getPairedDevice: (deviceId: string) => Promise<PairedDevice | null>;
  listCurrentNodes?: () => Promise<readonly NodeWorkerSupervisorNodeProof[]>;
  getIssue?: () => typeof NODE_RUNNER_UPDATE_REQUIRED_ISSUE | undefined;
  now?: () => number;
}) {
  const runtime = createDeviceWorkerRuntime({
    getPairedDevice: params.getPairedDevice,
    ...(params.now ? { now: params.now } : {}),
  });
  if (params.listCurrentNodes) {
    runtime.bindNodeTransport({
      listCurrentNodes: params.listCurrentNodes,
      hasCurrentRunner: () => true,
      ...(params.getIssue ? { getIssue: params.getIssue } : {}),
      isCurrent: () => true,
      invoke: async () => ({ ok: false }),
    });
  }
  return runtime;
}

describe("device worker provider", () => {
  it("binds targeted device reconciliation to the active worker service", async () => {
    const service = {};
    const reconcile = async (deviceId: string) => [`environment:${deviceId}`];

    await expect(reconcileDeviceWorker(service, DEVICE_ID)).resolves.toEqual([]);
    bindDeviceWorkerReconciliation(service, reconcile);
    await expect(reconcileDeviceWorker(service, DEVICE_ID)).resolves.toEqual([
      `environment:${DEVICE_ID}`,
    ]);
  });

  it("provisions deterministic node leases only for connected paired session hosts", async () => {
    const provider = deviceRuntime({
      getPairedDevice: async (deviceId) => pairedDevice(deviceId),
      listCurrentNodes: async () => [connectedNode()],
    }).provider;

    expect(provider.supportedExecutionModes).toEqual(["worker-turn", "remote-exec"]);
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
    const getPairedDevice = vi.fn(async () => null);
    const listCurrentNodes = vi.fn(async () => []);
    const disconnected = deviceRuntime({ getPairedDevice, listCurrentNodes }).provider;
    const allocation = await disconnected.resolveAllocation({ device: DEVICE_ID }, "operation-1");
    expect(allocation).toEqual({ leaseId: first.leaseId, sharedHost: true });
    await disconnected.destroy({ leaseId: allocation.leaseId, profile: { device: DEVICE_ID } });
    expect(getPairedDevice).not.toHaveBeenCalled();
    expect(listCurrentNodes).not.toHaveBeenCalled();
  });

  it("keeps a connected paired host available when all worker slots are occupied", async () => {
    const runtime = deviceRuntime({
      getPairedDevice: async () => pairedDevice(),
      listCurrentNodes: async () => [connectedNode(DEVICE_ID, false)],
    });

    await expect(runtime.resolveAvailability(DEVICE_ID)).resolves.toMatchObject({
      available: true,
    });
    await expect(runtime.provider.provision({ device: DEVICE_ID }, "remote-exec")).resolves.toEqual(
      expect.objectContaining({ node: { deviceId: DEVICE_ID }, sharedHost: true }),
    );
  });

  it.each([
    {
      name: "missing pairing",
      getPairedDevice: async () => null,
      listCurrentNodes: async () => [connectedNode()],
      expectedMessage: `device worker is not a paired node host: ${DEVICE_ID}`,
    },
    {
      name: "offline device",
      getPairedDevice: async () => pairedDevice(),
      listCurrentNodes: async () => [],
      expectedMessage: `device worker node is not connected: ${DEVICE_ID}; reconnect it before retrying`,
    },
  ])(
    "rejects $name during provision",
    async ({ getPairedDevice, listCurrentNodes, expectedMessage }) => {
      const provider = deviceRuntime({ getPairedDevice, listCurrentNodes }).provider;
      const provision = provider.provision({ device: DEVICE_ID }, "operation");

      await expect(provision).rejects.toBeInstanceOf(WorkerProviderError);
      await expect(provision).rejects.toMatchObject({ message: expectedMessage });
    },
  );

  it("returns the exact update-and-reconnect recovery for an outdated connected node", async () => {
    const provider = deviceRuntime({
      getPairedDevice: async () => pairedDevice(),
      listCurrentNodes: async () => [],
      getIssue: () => NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    }).provider;

    await expect(provider.provision({ device: DEVICE_ID }, "operation")).rejects.toThrow(
      `device worker node ${DEVICE_ID} requires an update before it can host sessions; run openclaw update, then reconnect it (for a headless node, run openclaw node restart)`,
    );
  });

  it.each([
    {
      name: "inside the dormancy ceiling",
      disconnectedAtMs: 6 * DAY_MS + 1,
      expected: { status: "dormant" },
    },
    {
      name: "at the dormancy ceiling",
      disconnectedAtMs: 6 * DAY_MS,
      expected: { status: "unknown" },
    },
    {
      name: "past the dormancy ceiling",
      disconnectedAtMs: DAY_MS,
      expected: { status: "unknown" },
    },
    {
      name: "without exact legacy disconnect history",
      disconnectedAtMs: undefined,
      expected: { status: "dormant" },
    },
  ])("reports an offline paired node as $name", async ({ disconnectedAtMs, expected }) => {
    const nowMs = 20 * DAY_MS;
    const device = pairedDevice(DEVICE_ID, {
      createdAtMs: 1,
      approvedAtMs: 1,
      lastConnectedAtMs: DAY_MS,
      ...(disconnectedAtMs === undefined ? {} : { lastDisconnectedAtMs: disconnectedAtMs }),
    });
    // General device activity must not extend node-worker dormancy.
    device.lastSeenAtMs = nowMs;
    const provider = deviceRuntime({
      getPairedDevice: async () => device,
      listCurrentNodes: async () => [],
      now: () => nowMs,
    }).provider;

    await expect(
      provider.inspect({ leaseId: "device-lease", profile: { device: DEVICE_ID } }),
    ).resolves.toEqual(expected);
  });

  it("reports active, dormant, and unknown from pairing plus live presence", async () => {
    let paired: PairedDevice | null = pairedDevice();
    let connected = true;
    let available = true;
    const runtime = deviceRuntime({
      getPairedDevice: async () => paired,
      listCurrentNodes: async () => (connected ? [connectedNode(DEVICE_ID, available)] : []),
    });
    const provider = runtime.provider;
    const lease = { leaseId: "device-lease", profile: { device: DEVICE_ID } };

    await expect(provider.inspect(lease)).resolves.toEqual({ status: "active", sharedHost: true });
    available = false;
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "active", sharedHost: true });
    connected = false;
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "dormant" });
    paired = null;
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "unknown" });
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
  });
});
