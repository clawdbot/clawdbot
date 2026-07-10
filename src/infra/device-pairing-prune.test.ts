// Covers silent-pairing approval provenance and superseded-record pruning.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  approveBootstrapDevicePairing,
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
  pruneSupersededSilentPairedDevices,
  requestDevicePairing,
  withPairedDeviceRecords,
  type PairedDeviceApprovalKind,
} from "./device-pairing.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-device-pairing-prune-" });

async function makeBaseDir(): Promise<string> {
  return await suiteRootTracker.make("case");
}

// Rewrites a paired record without approvedVia to simulate approvals that
// predate provenance tracking.
async function stripApprovalProvenance(baseDir: string, deviceId: string): Promise<void> {
  await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const device = pairedByDeviceId[deviceId];
    if (!device) {
      throw new Error(`expected paired device ${deviceId}`);
    }
    delete device.approvedVia;
    return { value: undefined, persist: true };
  });
}

// Ages every just-approved record past the recent-approval grace window.
function agedNowMs(): number {
  return Date.now() + 120_000;
}

async function pairDevice(params: {
  baseDir: string;
  deviceId: string;
  approvedVia?: Extract<PairedDeviceApprovalKind, "owner" | "silent" | "trusted-cidr">;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  roles?: string[];
}) {
  const request = await requestDevicePairing(
    {
      deviceId: params.deviceId,
      publicKey: `pk-${params.deviceId}`,
      clientId: params.clientId ?? "cli",
      clientMode: params.clientMode ?? "cli",
      displayName: params.displayName,
      role: params.roles?.[0] ?? "operator",
      roles: params.roles ?? ["operator"],
      scopes: [],
    },
    params.baseDir,
  );
  const approved = await approveDevicePairing(
    request.request.requestId,
    { callerScopes: [], approvedVia: params.approvedVia },
    params.baseDir,
  );
  if (approved?.status !== "approved") {
    throw new Error(`expected approval for ${params.deviceId}`);
  }
  return approved.device;
}

describe("device pairing approval provenance", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  test("records silent, owner, and bootstrap approval kinds", async () => {
    const baseDir = await makeBaseDir();
    const silent = await pairDevice({ baseDir, deviceId: "device-silent", approvedVia: "silent" });
    expect(silent.approvedVia).toBe("silent");

    const owner = await pairDevice({ baseDir, deviceId: "device-owner" });
    expect(owner.approvedVia).toBe("owner");

    const bootstrapRequest = await requestDevicePairing(
      {
        deviceId: "device-bootstrap",
        publicKey: "pk-device-bootstrap",
        role: "node",
        roles: ["node"],
        scopes: [],
      },
      baseDir,
    );
    const bootstrapApproved = await approveBootstrapDevicePairing(
      bootstrapRequest.request.requestId,
      { roles: ["node"], scopes: [] },
      baseDir,
    );
    expect(bootstrapApproved?.status === "approved" && bootstrapApproved.device.approvedVia).toBe(
      "bootstrap",
    );
  });

  test("owner approval stays sticky across a later silent re-approve", async () => {
    const baseDir = await makeBaseDir();
    await pairDevice({ baseDir, deviceId: "device-sticky" });
    const repaired = await pairDevice({
      baseDir,
      deviceId: "device-sticky",
      approvedVia: "silent",
    });
    expect(repaired.approvedVia).toBe("owner");
  });

  test("pre-provenance records stay unknown across a later silent re-approve", async () => {
    const baseDir = await makeBaseDir();
    const legacy = await pairDevice({ baseDir, deviceId: "device-legacy", approvedVia: "silent" });
    await stripApprovalProvenance(baseDir, legacy.deviceId);

    const repaired = await pairDevice({
      baseDir,
      deviceId: "device-legacy",
      approvedVia: "silent",
    });
    expect(repaired.approvedVia).toBeUndefined();
  });
});

describe("pruneSupersededSilentPairedDevices", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  test("removes stale silent siblings from the same client cluster only", async () => {
    const baseDir = await makeBaseDir();
    await pairDevice({ baseDir, deviceId: "stale-1", approvedVia: "silent" });
    await pairDevice({ baseDir, deviceId: "stale-2", approvedVia: "silent" });
    await pairDevice({ baseDir, deviceId: "owner-kept" });
    await pairDevice({ baseDir, deviceId: "cidr-kept", approvedVia: "trusted-cidr" });
    await pairDevice({
      baseDir,
      deviceId: "other-cluster",
      approvedVia: "silent",
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    const anchor = await pairDevice({ baseDir, deviceId: "anchor", approvedVia: "silent" });

    const removed = await pruneSupersededSilentPairedDevices({
      deviceId: anchor.deviceId,
      baseDir,
      nowMs: agedNowMs(),
    });

    expect(removed.map((entry) => entry.deviceId).toSorted()).toEqual(["stale-1", "stale-2"]);
    expect(removed[0]?.roles).toEqual(["operator"]);
    const remaining = (await listDevicePairing(baseDir)).paired.map((device) => device.deviceId);
    expect(remaining.toSorted()).toEqual(["anchor", "cidr-kept", "other-cluster", "owner-kept"]);
  });

  test("trusted-cidr approvals never anchor a prune", async () => {
    const baseDir = await makeBaseDir();
    await pairDevice({
      baseDir,
      deviceId: "cidr-stale",
      approvedVia: "trusted-cidr",
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    const anchor = await pairDevice({
      baseDir,
      deviceId: "cidr-anchor",
      approvedVia: "trusted-cidr",
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });

    const removed = await pruneSupersededSilentPairedDevices({
      deviceId: anchor.deviceId,
      baseDir,
      nowMs: agedNowMs(),
    });

    expect(removed).toEqual([]);
    expect(await getPairedDevice("cidr-stale", baseDir)).not.toBeNull();
  });

  test("skips freshly approved siblings still inside the grace window", async () => {
    const baseDir = await makeBaseDir();
    await pairDevice({ baseDir, deviceId: "in-flight", approvedVia: "silent" });
    const anchor = await pairDevice({ baseDir, deviceId: "anchor", approvedVia: "silent" });

    // Real now: the sibling was approved milliseconds ago, so a concurrent
    // handshake that has not registered its connection yet must survive.
    const removed = await pruneSupersededSilentPairedDevices({
      deviceId: anchor.deviceId,
      baseDir,
    });

    expect(removed).toEqual([]);
    expect(await getPairedDevice("in-flight", baseDir)).not.toBeNull();
  });

  test("skips connected devices and drops pending requests for pruned ids", async () => {
    const baseDir = await makeBaseDir();
    await pairDevice({ baseDir, deviceId: "stale", approvedVia: "silent" });
    await pairDevice({ baseDir, deviceId: "live", approvedVia: "silent" });
    const anchor = await pairDevice({ baseDir, deviceId: "anchor", approvedVia: "silent" });
    // A pruned device may still have a queued repair request; it must go too.
    await requestDevicePairing(
      {
        deviceId: "stale",
        publicKey: "pk-stale-repair",
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        scopes: [],
      },
      baseDir,
    );

    const removed = await pruneSupersededSilentPairedDevices({
      deviceId: anchor.deviceId,
      baseDir,
      nowMs: agedNowMs(),
      isDeviceConnected: (deviceId) => deviceId === "live",
    });

    expect(removed.map((entry) => entry.deviceId)).toEqual(["stale"]);
    const list = await listDevicePairing(baseDir);
    expect(list.paired.map((device) => device.deviceId).toSorted()).toEqual(["anchor", "live"]);
    expect(list.pending).toHaveLength(0);
  });

  test("does not prune when the anchor was not silent-approved", async () => {
    const baseDir = await makeBaseDir();
    await pairDevice({ baseDir, deviceId: "stale", approvedVia: "silent" });
    const anchor = await pairDevice({ baseDir, deviceId: "anchor-owner" });

    const removed = await pruneSupersededSilentPairedDevices({
      deviceId: anchor.deviceId,
      baseDir,
      nowMs: agedNowMs(),
    });

    expect(removed).toEqual([]);
    expect(await getPairedDevice("stale", baseDir)).not.toBeNull();
  });

  test("leaves legacy records without approval provenance untouched", async () => {
    const baseDir = await makeBaseDir();
    const legacy = await pairDevice({ baseDir, deviceId: "legacy", approvedVia: "silent" });
    await stripApprovalProvenance(baseDir, legacy.deviceId);
    const anchor = await pairDevice({ baseDir, deviceId: "anchor", approvedVia: "silent" });

    const removed = await pruneSupersededSilentPairedDevices({
      deviceId: anchor.deviceId,
      baseDir,
      nowMs: agedNowMs(),
    });

    expect(removed).toEqual([]);
    expect(await getPairedDevice("legacy", baseDir)).not.toBeNull();
  });
});
