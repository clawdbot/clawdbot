// Covers gateway-side cleanup when silent pairing supersedes stale sibling records.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  approveDevicePairing,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { approveNodePairing, listNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { pruneSupersededSilentPairingsAfterApproval } from "./device-pairing-prune.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-pairing-prune-" });

type BroadcastCall = { event: string; payload: Record<string, unknown> };
type PruneContext = Parameters<typeof pruneSupersededSilentPairingsAfterApproval>[0]["context"];

function createPruneContext(params?: { connectedDeviceIds?: string[] }) {
  const broadcasts: BroadcastCall[] = [];
  const invalidated: string[] = [];
  const disconnected: string[] = [];
  const logs: string[] = [];
  const connected = new Set(params?.connectedDeviceIds ?? []);
  const context: PruneContext = {
    broadcast: (event, payload) => {
      broadcasts.push({ event, payload: payload as Record<string, unknown> });
    },
    logGateway: {
      info: (message: string) => logs.push(message),
    },
    hasConnectedClientsForDevice: (deviceId: string) => connected.has(deviceId),
    invalidateClientsForDevice: (deviceId: string) => {
      invalidated.push(deviceId);
    },
    disconnectClientsForDevice: (deviceId: string) => {
      disconnected.push(deviceId);
    },
  };
  return { broadcasts, invalidated, disconnected, logs, context };
}

async function pairSilentDevice(params: {
  baseDir: string;
  deviceId: string;
  roles: string[];
  clientId: string;
  clientMode: string;
  displayName?: string;
}) {
  const request = await requestDevicePairing(
    {
      deviceId: params.deviceId,
      publicKey: `pk-${params.deviceId}`,
      clientId: params.clientId,
      clientMode: params.clientMode,
      displayName: params.displayName,
      role: params.roles[0],
      roles: params.roles,
      scopes: [],
    },
    params.baseDir,
  );
  const approved = await approveDevicePairing(
    request.request.requestId,
    { callerScopes: [], approvedVia: "silent" },
    params.baseDir,
  );
  if (approved?.status !== "approved") {
    throw new Error(`expected approval for ${params.deviceId}`);
  }
  return approved.device;
}

describe("pruneSupersededSilentPairingsAfterApproval", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  test("retires stale node siblings across both pairing stores", async () => {
    const baseDir = await suiteRootTracker.make("case");
    await pairSilentDevice({
      baseDir,
      deviceId: "node-stale",
      roles: ["node"],
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    const nodeRequest = await requestNodePairing(
      { nodeId: "node-stale", displayName: "megaclaw" },
      baseDir,
    );
    await approveNodePairing(nodeRequest.request.requestId, { callerScopes: [] }, baseDir);
    const anchor = await pairSilentDevice({
      baseDir,
      deviceId: "node-anchor",
      roles: ["node"],
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });

    const harness = createPruneContext();
    const pruned = await pruneSupersededSilentPairingsAfterApproval({
      deviceId: anchor.deviceId,
      context: harness.context,
      baseDir,
      nowMs: Date.now() + 120_000,
    });

    expect(pruned.map((entry) => entry.deviceId)).toEqual(["node-stale"]);
    const devices = await listDevicePairing(baseDir);
    expect(devices.paired.map((device) => device.deviceId)).toEqual(["node-anchor"]);
    const nodes = await listNodePairing(baseDir);
    expect(nodes.paired).toHaveLength(0);
    expect(harness.invalidated).toEqual(["node-stale"]);
    expect(harness.disconnected).toEqual(["node-stale"]);
    expect(harness.broadcasts).toEqual([
      {
        event: "node.pair.resolved",
        payload: expect.objectContaining({ nodeId: "node-stale", decision: "removed" }),
      },
    ]);
  });

  test("keeps connected siblings and emits no node broadcast for operator-only prunes", async () => {
    const baseDir = await suiteRootTracker.make("case");
    await pairSilentDevice({
      baseDir,
      deviceId: "cli-stale",
      roles: ["operator"],
      clientId: "cli",
      clientMode: "cli",
    });
    await pairSilentDevice({
      baseDir,
      deviceId: "cli-live",
      roles: ["operator"],
      clientId: "cli",
      clientMode: "cli",
    });
    const anchor = await pairSilentDevice({
      baseDir,
      deviceId: "cli-anchor",
      roles: ["operator"],
      clientId: "cli",
      clientMode: "cli",
    });

    const harness = createPruneContext({ connectedDeviceIds: ["cli-live"] });
    const pruned = await pruneSupersededSilentPairingsAfterApproval({
      deviceId: anchor.deviceId,
      context: harness.context,
      baseDir,
      nowMs: Date.now() + 120_000,
    });

    expect(pruned.map((entry) => entry.deviceId)).toEqual(["cli-stale"]);
    const devices = await listDevicePairing(baseDir);
    expect(devices.paired.map((device) => device.deviceId).toSorted()).toEqual([
      "cli-anchor",
      "cli-live",
    ]);
    expect(harness.broadcasts).toEqual([]);
    expect(harness.disconnected).toEqual(["cli-stale"]);
  });
});
