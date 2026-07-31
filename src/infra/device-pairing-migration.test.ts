// Covers the one-time devices/*.json → SQLite pairing store import.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { migrateLegacyDevicePairingStore } from "./device-pairing-migration.js";
import {
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
  type PairedDevice,
} from "./device-pairing.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";

const suiteRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-device-pairing-migration-",
});

beforeAll(async () => {
  await suiteRootTracker.setup();
});

afterAll(async () => {
  closeOpenClawStateDatabaseForTest();
  await suiteRootTracker.cleanup();
});

function legacyPairedDevice(deviceId: string, extra: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId,
    publicKey: `pk-${deviceId}`,
    displayName: `Device ${deviceId}`,
    clientId: "openclaw-ios",
    clientMode: "node",
    role: "node",
    roles: ["node"],
    scopes: [],
    approvedScopes: [],
    tokens: {
      node: {
        token: ["legacy", deviceId].join("-"),
        role: "node",
        scopes: [],
        createdAtMs: 1_700_000_000_000,
      },
    },
    approvedVia: "owner",
    createdAtMs: 1_700_000_000_000,
    approvedAtMs: 1_700_000_000_000,
    ...extra,
  };
}

async function writeLegacyFiles(
  baseDir: string,
  files: { paired?: Record<string, PairedDevice>; pending?: unknown; bootstrap?: unknown },
): Promise<string> {
  const devicesDir = path.join(baseDir, "devices");
  await fs.mkdir(devicesDir, { recursive: true });
  if (files.paired !== undefined) {
    await fs.writeFile(path.join(devicesDir, "paired.json"), JSON.stringify(files.paired));
  }
  if (files.pending !== undefined) {
    await fs.writeFile(path.join(devicesDir, "pending.json"), JSON.stringify(files.pending));
  }
  if (files.bootstrap !== undefined) {
    await fs.writeFile(path.join(devicesDir, "bootstrap.json"), JSON.stringify(files.bootstrap));
  }
  return devicesDir;
}

async function listDeviceFiles(devicesDir: string): Promise<string[]> {
  return (await fs.readdir(devicesDir)).toSorted();
}

describe("migrateLegacyDevicePairingStore", () => {
  test("imports legacy paired records and archives all legacy files", async () => {
    const baseDir = await suiteRootTracker.make("import");
    const nodeSurface = {
      displayName: "Living Room iPad",
      caps: ["camera"],
      createdAtMs: 1_700_000_000_000,
      approvedAtMs: 1_700_000_000_000,
    };
    const devicesDir = await writeLegacyFiles(baseDir, {
      paired: {
        "device-a": legacyPairedDevice("device-a", { nodeSurface }),
        "device-b": legacyPairedDevice("device-b"),
      },
      pending: { "req-1": { requestId: "req-1", deviceId: "device-c", ts: Date.now() } },
      bootstrap: { token: { token: "tok", ts: Date.now(), issuedAtMs: Date.now() } },
    });

    const result = await migrateLegacyDevicePairingStore({ baseDir });
    expect(result).toEqual({ imported: 2, skippedExisting: 0 });

    const imported = await getPairedDevice("device-a", baseDir);
    expect(imported).toMatchObject({
      deviceId: "device-a",
      publicKey: "pk-device-a",
      approvedVia: "owner",
      nodeSurface,
    });
    expect(imported?.tokens?.node?.token).toBe(["legacy", "device-a"].join("-"));

    // Transient pending/bootstrap rows are dropped, not imported.
    expect((await listDevicePairing(baseDir)).pending).toEqual([]);

    expect(await listDeviceFiles(devicesDir)).toEqual([
      "bootstrap.json.migrated",
      "paired.json.migrated",
      "pending.json.migrated",
    ]);

    // Second run is a no-op.
    expect(await migrateLegacyDevicePairingStore({ baseDir })).toBeNull();
  });

  test("keeps existing SQLite records over legacy rows for the same device id", async () => {
    const baseDir = await suiteRootTracker.make("existing-wins");
    const pending = await requestDevicePairing(
      {
        deviceId: "device-a",
        publicKey: "pk-current",
        role: "node",
        roles: ["node"],
        scopes: [],
      },
      baseDir,
    );
    const approved = await approveDevicePairing(
      pending.request.requestId,
      { callerScopes: [] },
      baseDir,
    );
    expect(approved?.status).toBe("approved");

    await writeLegacyFiles(baseDir, {
      paired: { "device-a": legacyPairedDevice("device-a") },
    });

    const result = await migrateLegacyDevicePairingStore({ baseDir });
    expect(result).toEqual({ imported: 0, skippedExisting: 1 });
    expect((await getPairedDevice("device-a", baseDir))?.publicKey).toBe("pk-current");
  });

  test("returns null when no legacy files exist", async () => {
    const baseDir = await suiteRootTracker.make("empty");
    expect(await migrateLegacyDevicePairingStore({ baseDir })).toBeNull();
  });

  test("throws on an unreadable paired store and leaves the files in place", async () => {
    const baseDir = await suiteRootTracker.make("corrupt");
    const devicesDir = path.join(baseDir, "devices");
    await fs.mkdir(devicesDir, { recursive: true });
    await fs.writeFile(path.join(devicesDir, "paired.json"), "{not-json}");

    await expect(migrateLegacyDevicePairingStore({ baseDir })).rejects.toThrow();
    expect(await listDeviceFiles(devicesDir)).toEqual(["paired.json"]);
  });

  test("archives transient-only legacy files without importing anything", async () => {
    const baseDir = await suiteRootTracker.make("transient-only");
    const devicesDir = await writeLegacyFiles(baseDir, {
      pending: {},
      bootstrap: {},
    });

    const result = await migrateLegacyDevicePairingStore({ baseDir });
    expect(result).toEqual({ imported: 0, skippedExisting: 0 });
    expect(await listDeviceFiles(devicesDir)).toEqual([
      "bootstrap.json.migrated",
      "pending.json.migrated",
    ]);
  });

  test("device import before node fold lets legacy node surfaces land on imported records", async () => {
    const baseDir = await suiteRootTracker.make("with-node-fold");
    await writeLegacyFiles(baseDir, {
      paired: { "device-a": legacyPairedDevice("device-a") },
    });
    const nodesDir = path.join(baseDir, "nodes");
    await fs.mkdir(nodesDir, { recursive: true });
    await fs.writeFile(
      path.join(nodesDir, "paired.json"),
      JSON.stringify({
        "device-a": {
          nodeId: "device-a",
          displayName: "Kitchen Display",
          caps: ["screen"],
          createdAtMs: 1_700_000_000_000,
          approvedAtMs: 1_700_000_000_000,
        },
      }),
    );

    await migrateLegacyDevicePairingStore({ baseDir });
    const folded = await migrateLegacyNodePairingStore({ baseDir });
    expect(folded).toEqual({ migrated: 1, orphaned: 0 });
    expect((await getPairedDevice("device-a", baseDir))?.nodeSurface).toMatchObject({
      displayName: "Kitchen Display",
      caps: ["screen"],
    });
  });
});
