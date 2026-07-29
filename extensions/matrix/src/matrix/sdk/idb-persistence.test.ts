// Matrix tests cover idb persistence plugin behavior.
import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { readMatrixIdbSnapshotJson, writeMatrixIdbSnapshotJson } from "../crypto-state-store.js";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
  seedDatabase,
} from "./idb-persistence.test-helpers.js";
import { LogService } from "./logger.js";

const DATABASE_PREFIX = "openclaw-matrix-persistence-test";
const OTHER_DATABASE_PREFIX = "openclaw-matrix-persistence-other-test";
const cryptoDatabaseName = `${DATABASE_PREFIX}::matrix-sdk-crypto`;
const otherCryptoDatabaseName = `${OTHER_DATABASE_PREFIX}::matrix-sdk-crypto`;

async function clearTestIndexedDbState(): Promise<void> {
  await clearAllIndexedDbState({ databasePrefix: DATABASE_PREFIX });
  await clearAllIndexedDbState({ databasePrefix: OTHER_DATABASE_PREFIX });
}

describe("Matrix IndexedDB persistence", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-persist-"));
    warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    await clearTestIndexedDbState();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await clearTestIndexedDbState();
    resetFileLockStateForTest();
    resetPluginStateStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists and restores database contents for the selected prefix", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });
    await seedDatabase({
      name: otherCryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-2", value: { session: "should-not-restore" } }],
    });

    await persistIdbToDisk({
      snapshotPath,
      databasePrefix: DATABASE_PREFIX,
    });
    expect(fs.existsSync(snapshotPath)).toBe(false);

    await clearTestIndexedDbState();

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(true);

    const restoredRecords = await readDatabaseRecords({
      name: cryptoDatabaseName,
      storeName: "sessions",
    });
    expect(restoredRecords).toEqual([{ key: "room-1", value: { session: "abc123" } }]);

    const dbs = await indexedDB.databases();
    expect(dbs.map((entry) => entry.name)).not.toContain(otherCryptoDatabaseName);
  });

  it("blocks runtime restore and persistence until doctor migrates the legacy snapshot", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const snapshot = JSON.stringify([{ name: cryptoDatabaseName, version: 1, stores: [] }]);
    fs.writeFileSync(snapshotPath, snapshot);

    await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject({
      name: "MatrixIdbSnapshotMigrationRequiredError",
      code: "matrix-idb-snapshot-requires-doctor",
      remediation: "openclaw doctor --fix",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "IdbPersistence",
      expect.objectContaining({
        code: "matrix-idb-snapshot-requires-doctor",
        remediation: "openclaw doctor --fix",
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(snapshotPath);

    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "new-room", value: { session: "new" } }],
    });
    await expect(
      persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX }),
    ).rejects.toMatchObject({
      code: "matrix-idb-snapshot-requires-doctor",
    });
    expect(readMatrixIdbSnapshotJson(tmpDir)).toBeNull();
    expect(fs.existsSync(snapshotPath)).toBe(true);

    writeMatrixIdbSnapshotJson({
      storageRootDir: tmpDir,
      snapshotJson: JSON.stringify({ malformed: true }),
      databaseCount: 1,
    });
    await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject({
      code: "matrix-idb-snapshot-requires-doctor",
    });
    const storeSpy = vi
      .spyOn(getMatrixRuntime().state, "openSyncKeyedStore")
      .mockImplementation(() => {
        throw new Error("sqlite unavailable");
      });

    try {
      await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject({
        code: "matrix-idb-snapshot-requires-doctor",
      });
    } finally {
      storeSpy.mockRestore();
    }
  });

  it("returns false without warning when the snapshot does not exist yet", async () => {
    const restored = await restoreIdbFromDisk(path.join(tmpDir, "crypto-idb-snapshot.json"));

    expect(restored).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles concurrent persist operations in SQLite state", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });

    await Promise.all([
      persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX }),
      persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX }),
    ]);

    expect(fs.existsSync(snapshotPath)).toBe(false);
    await clearTestIndexedDbState();
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({
        name: cryptoDatabaseName,
        storeName: "sessions",
      }),
    ).resolves.toEqual([{ key: "room-1", value: { session: "abc123" } }]);
  });
});
