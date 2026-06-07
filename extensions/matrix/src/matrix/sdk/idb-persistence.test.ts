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

  it("imports and archives a legacy JSON snapshot during restore", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify([
        {
          name: cryptoDatabaseName,
          version: 1,
          stores: [
            {
              name: "sessions",
              keyPath: null,
              autoIncrement: false,
              indexes: [],
              records: [{ key: "room-1", value: { session: "legacy" } }],
            },
          ],
        },
      ]),
      "utf8",
    );

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(true);
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(fs.existsSync(`${snapshotPath}.migrated`)).toBe(true);

    await clearTestIndexedDbState();
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({
        name: cryptoDatabaseName,
        storeName: "sessions",
      }),
    ).resolves.toEqual([{ key: "room-1", value: { session: "legacy" } }]);
  });

  it("restores a valid legacy JSON snapshot when SQLite import fails", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify([
        {
          name: cryptoDatabaseName,
          version: 1,
          stores: [
            {
              name: "sessions",
              keyPath: null,
              autoIncrement: false,
              indexes: [],
              records: [{ key: "room-1", value: { session: "legacy" } }],
            },
          ],
        },
      ]),
      "utf8",
    );
    vi.spyOn(getMatrixRuntime().state, "openSyncKeyedStore").mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });

    const restored = await restoreIdbFromDisk(snapshotPath);

    expect(restored).toBe(true);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    await expect(
      readDatabaseRecords({
        name: cryptoDatabaseName,
        storeName: "sessions",
      }),
    ).resolves.toEqual([{ key: "room-1", value: { session: "legacy" } }]);
  });

  it("returns false and logs a warning for malformed snapshots", async () => {
    const snapshotPath = path.join(tmpDir, "bad-snapshot.json");
    fs.writeFileSync(snapshotPath, JSON.stringify([{ nope: true }]), "utf8");

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [scope, message, error] = warnSpy.mock.calls.at(0) ?? [];
    expect(scope).toBe("IdbPersistence");
    expect(message).toBe(`Failed to restore IndexedDB snapshot from ${snapshotPath}:`);
    expect(error).toBeInstanceOf(Error);
  });

  it("returns false for empty snapshot payloads without restoring databases", async () => {
    const snapshotPath = path.join(tmpDir, "empty-snapshot.json");
    fs.writeFileSync(snapshotPath, JSON.stringify([]), "utf8");

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(false);

    const dbs = await indexedDB.databases();
    expect(dbs).toStrictEqual([]);
  });

  it("returns false without warning when the snapshot does not exist yet", async () => {
    const restored = await restoreIdbFromDisk(path.join(tmpDir, "missing-snapshot.json"));

    expect(restored).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles concurrent persist operations in SQLite state", async () => {
    const snapshotPath = path.join(tmpDir, "concurrent-persist.json");
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

  it("archives an existing legacy snapshot file after persist", async () => {
    const snapshotPath = path.join(tmpDir, "persist-archives-legacy.json");
    fs.writeFileSync(snapshotPath, "[]", "utf8");
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });

    await persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX });

    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(fs.existsSync(`${snapshotPath}.migrated`)).toBe(true);
  });
});
