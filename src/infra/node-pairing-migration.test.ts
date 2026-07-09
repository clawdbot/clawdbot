// Covers the one-time fold of the legacy nodes/*.json store into device records.
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { approveDevicePairing, getPairedDevice, requestDevicePairing } from "./device-pairing.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";
import { listNodePairing } from "./node-pairing.js";
import { resolvePairingPaths, writeJson } from "./pairing-files.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-migration-" });

async function seedNodeDevice(baseDir: string, deviceId: string): Promise<void> {
  const request = await requestDevicePairing(
    { deviceId, publicKey: `pk-${deviceId}`, role: "node", roles: ["node"], scopes: [] },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
}

describe("migrateLegacyNodePairingStore", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  test("returns null when no legacy store exists", async () => {
    const baseDir = await suiteRootTracker.make("case");
    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toBeNull();
  });

  test("folds legacy rows into device records, drops orphans, archives files", async () => {
    const baseDir = await suiteRootTracker.make("case");
    const legacyTokenValue = ["legacy", "token"].join("-");
    await seedNodeDevice(baseDir, "node-kept");
    const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
    await writeJson(pairedPath, {
      "node-kept": {
        nodeId: "node-kept",
        token: legacyTokenValue,
        displayName: "Living Room iPad",
        version: "2026.6.11",
        caps: ["canvas", "screen"],
        commands: ["screen.snapshot", "system.run"],
        permissions: { camera: true },
        bins: ["ffmpeg"],
        createdAtMs: 1_000,
        approvedAtMs: 2_000,
        lastConnectedAtMs: 3_000,
      },
      "node-orphaned": {
        nodeId: "node-orphaned",
        token: `${legacyTokenValue}-2`,
        approvedAtMs: 2_000,
        createdAtMs: 1_000,
      },
    });
    await writeJson(pendingPath, {
      "req-1": { requestId: "req-1", nodeId: "node-kept", ts: Date.now() },
    });

    const result = await migrateLegacyNodePairingStore({ baseDir });
    expect(result).toEqual({ migrated: 1, orphaned: 1 });

    const device = await getPairedDevice("node-kept", baseDir);
    expect(device?.nodeSurface).toEqual({
      displayName: "Living Room iPad",
      version: "2026.6.11",
      coreVersion: undefined,
      uiVersion: undefined,
      modelIdentifier: undefined,
      caps: ["canvas", "screen"],
      commands: ["screen.snapshot", "system.run"],
      permissions: { camera: true },
      bins: ["ffmpeg"],
      createdAtMs: 1_000,
      approvedAtMs: 2_000,
      lastConnectedAtMs: 3_000,
    });
    // The retired token never crosses into the device record.
    expect(JSON.stringify(device)).not.toContain(legacyTokenValue);

    const list = await listNodePairing(baseDir);
    expect(list.paired.map((node) => node.nodeId)).toEqual(["node-kept"]);
    expect(list.pending).toHaveLength(0);

    // Legacy files archived; a second run is a no-op.
    await expect(fs.access(pairedPath)).rejects.toThrow();
    await expect(fs.access(`${pairedPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${pendingPath}.migrated`)).resolves.toBeUndefined();
    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toBeNull();
  });

  test("keeps an existing device surface over stale legacy rows", async () => {
    const baseDir = await suiteRootTracker.make("case");
    await seedNodeDevice(baseDir, "node-current");
    const { requestNodePairing, approveNodePairing } = await import("./node-pairing.js");
    const pending = await requestNodePairing(
      { nodeId: "node-current", caps: ["screen"], commands: ["screen.snapshot"] },
      baseDir,
    );
    await approveNodePairing(
      pending.request.requestId,
      { callerScopes: ["operator.pairing", "operator.write"] },
      baseDir,
    );

    const { pairedPath } = resolvePairingPaths(baseDir, "nodes");
    await writeJson(pairedPath, {
      "node-current": {
        nodeId: "node-current",
        caps: ["stale-cap"],
        commands: ["stale.command"],
        createdAtMs: 1,
        approvedAtMs: 2,
      },
    });

    const result = await migrateLegacyNodePairingStore({ baseDir });
    expect(result).toEqual({ migrated: 0, orphaned: 0 });
    const device = await getPairedDevice("node-current", baseDir);
    expect(device?.nodeSurface?.caps).toEqual(["screen"]);
  });
});
