import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  drainFileLockStateForTest,
  resetFileLockStateForTest,
} from "openclaw/plugin-sdk/file-lock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
  seedDatabase,
} from "./idb-persistence.test-helpers.js";
import { LogService } from "./logger.js";

describe("Matrix IndexedDB persistence", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-persist-"));
    warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    await clearAllIndexedDbState();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await clearAllIndexedDbState();
    resetFileLockStateForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists and restores database contents for the selected prefix", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await seedDatabase({
      name: "openclaw-matrix-test::matrix-sdk-crypto",
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });
    await seedDatabase({
      name: "other-prefix::matrix-sdk-crypto",
      storeName: "sessions",
      records: [{ key: "room-2", value: { session: "should-not-restore" } }],
    });

    await persistIdbToDisk({
      snapshotPath,
      databasePrefix: "openclaw-matrix-test",
    });
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const mode = fs.statSync(snapshotPath).mode & 0o777;
    expect(mode).toBe(0o600);

    await clearAllIndexedDbState();

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(true);

    const restoredRecords = await readDatabaseRecords({
      name: "openclaw-matrix-test::matrix-sdk-crypto",
      storeName: "sessions",
    });
    expect(restoredRecords).toEqual([{ key: "room-1", value: { session: "abc123" } }]);

    const dbs = await indexedDB.databases();
    expect(dbs.some((entry) => entry.name === "other-prefix::matrix-sdk-crypto")).toBe(false);
  });

  it("returns false and logs a warning for malformed snapshots", async () => {
    const snapshotPath = path.join(tmpDir, "bad-snapshot.json");
    fs.writeFileSync(snapshotPath, JSON.stringify([{ nope: true }]), "utf8");

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "IdbPersistence",
      expect.stringContaining(`Failed to restore IndexedDB snapshot from ${snapshotPath}:`),
      expect.any(Error),
    );
  });

  it("returns false for empty snapshot payloads without restoring databases", async () => {
    const snapshotPath = path.join(tmpDir, "empty-snapshot.json");
    fs.writeFileSync(snapshotPath, JSON.stringify([]), "utf8");

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(false);

    const dbs = await indexedDB.databases();
    expect(dbs).toEqual([]);
  });

  it("returns false without warning when the snapshot does not exist yet", async () => {
    const restored = await restoreIdbFromDisk(path.join(tmpDir, "missing-snapshot.json"));

    expect(restored).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("serializes concurrent persist operations via file lock", async () => {
    const snapshotPath = path.join(tmpDir, "concurrent-persist.json");
    await seedDatabase({
      name: "openclaw-matrix-test::matrix-sdk-crypto",
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });

    await Promise.all([
      persistIdbToDisk({ snapshotPath, databasePrefix: "openclaw-matrix-test" }),
      persistIdbToDisk({ snapshotPath, databasePrefix: "openclaw-matrix-test" }),
    ]);

    expect(fs.existsSync(snapshotPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
  });

  it("releases lock after persist completes", async () => {
    const snapshotPath = path.join(tmpDir, "lock-release.json");
    await seedDatabase({
      name: "openclaw-matrix-test::matrix-sdk-crypto",
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });

    await persistIdbToDisk({ snapshotPath, databasePrefix: "openclaw-matrix-test" });

    const lockPath = `${snapshotPath}.lock`;
    expect(fs.existsSync(lockPath)).toBe(false);
    await drainFileLockStateForTest();
  });

  it("releases lock after restore completes", async () => {
    const snapshotPath = path.join(tmpDir, "lock-release-restore.json");
    await seedDatabase({
      name: "openclaw-matrix-test::matrix-sdk-crypto",
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });

    await persistIdbToDisk({ snapshotPath, databasePrefix: "openclaw-matrix-test" });
    await clearAllIndexedDbState();
    await drainFileLockStateForTest();

    await restoreIdbFromDisk(snapshotPath);

    const lockPath = `${snapshotPath}.lock`;
    expect(fs.existsSync(lockPath)).toBe(false);
    await drainFileLockStateForTest();
  });
});
