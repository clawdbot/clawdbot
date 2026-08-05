// Covers the one-time fold of the legacy nodes/*.json store into device records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { approveDevicePairing, getPairedDevice, requestDevicePairing } from "./device-pairing.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";
import {
  approveNodePairing,
  listNodePairing,
  recordPairedNodeConnection,
  requestNodePairing,
} from "./node-pairing.js";
import { resolvePairingPaths } from "./pairing-files.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-migration-" });

async function seedNodeDevice(baseDir: string, deviceId: string): Promise<void> {
  const request = await requestDevicePairing(
    { deviceId, publicKey: `pk-${deviceId}`, role: "node", roles: ["node"], scopes: [] },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

  test("folds legacy rows into device records, drops orphans, and archives files", async () => {
    const baseDir = await suiteRootTracker.make("case");
    await seedNodeDevice(baseDir, "node-kept");
    const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "nodes");
    await writeJson(pairedPath, {
      "node-kept": {
        nodeId: "node-kept",
        token: "retired-token",
        displayName: "Living Room iPad",
        caps: ["canvas", "screen"],
        commands: ["screen.snapshot", "system.run"],
        createdAtMs: 1_000,
        approvedAtMs: 2_000,
      },
      "node-orphaned": {
        nodeId: "node-orphaned",
        token: "orphaned-token",
        createdAtMs: 1_000,
        approvedAtMs: 2_000,
      },
    });
    await writeJson(pendingPath, {
      "req-1": { requestId: "req-1", nodeId: "node-kept", ts: Date.now() },
    });

    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toEqual({
      migrated: 1,
      orphaned: 1,
    });
    const device = await getPairedDevice("node-kept", baseDir);
    expect(device?.nodeSurface).toMatchObject({
      displayName: "Living Room iPad",
      caps: ["canvas", "screen"],
      commands: ["screen.snapshot", "system.run"],
    });
    expect(JSON.stringify(device)).not.toContain("retired-token");
    expect((await listNodePairing(baseDir)).paired.map((node) => node.nodeId)).toEqual([
      "node-kept",
    ]);
    await expect(fs.access(pairedPath)).rejects.toThrow();
    await expect(fs.access(`${pairedPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${pendingPath}.migrated`)).resolves.toBeUndefined();
    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toBeNull();
  });

  test("keeps an existing device surface over stale legacy rows", async () => {
    const baseDir = await suiteRootTracker.make("case");
    await seedNodeDevice(baseDir, "node-current");
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

    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toEqual({
      migrated: 0,
      orphaned: 0,
    });
    expect((await getPairedDevice("node-current", baseDir))?.nodeSurface?.caps).toEqual(["screen"]);
  });

  test("drops legacy client-instance aliases and reapproves the canonical device id", async () => {
    const baseDir = await suiteRootTracker.make("case");
    await seedNodeDevice(baseDir, "canonical-device-id");
    const { pairedPath } = resolvePairingPaths(baseDir, "nodes");
    await writeJson(pairedPath, {
      "legacy-client-instance-id": {
        nodeId: "legacy-client-instance-id",
        commands: ["system.notify"],
        createdAtMs: 1_000,
        approvedAtMs: 2_000,
        lastConnectedAtMs: 3_000,
      },
    });

    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toEqual({
      migrated: 0,
      orphaned: 1,
    });
    await expect(
      recordPairedNodeConnection("legacy-client-instance-id", 4_000, baseDir),
    ).resolves.toEqual({
      recorded: false,
    });

    const pending = await requestNodePairing(
      { nodeId: "canonical-device-id", commands: ["system.notify"] },
      baseDir,
    );
    await expect(
      approveNodePairing(
        pending.request.requestId,
        { callerScopes: ["operator.pairing", "operator.write"] },
        baseDir,
      ),
    ).resolves.toMatchObject({ node: { nodeId: "canonical-device-id" } });
    await expect(
      recordPairedNodeConnection("canonical-device-id", 4_000, baseDir),
    ).resolves.toEqual({
      recorded: true,
      firstConnection: true,
    });
    await expect(
      recordPairedNodeConnection("canonical-device-id", 5_000, baseDir),
    ).resolves.toEqual({
      recorded: true,
      firstConnection: false,
    });
  });
});
