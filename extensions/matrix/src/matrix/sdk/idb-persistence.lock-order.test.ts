import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeMinimumRetryWindowMs,
  MATRIX_IDB_PERSIST_INTERVAL_MS,
} from "./idb-persistence-lock.js";
import { clearAllIndexedDbState, seedDatabase } from "./idb-persistence.test-helpers.js";

const { withFileLockMock } = vi.hoisted(() => ({
  withFileLockMock: vi.fn(
    async <T>(_filePath: string, _options: unknown, fn: () => Promise<T>) => await fn(),
  ),
}));

vi.mock("openclaw/plugin-sdk/file-lock", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/file-lock")>(
    "openclaw/plugin-sdk/file-lock",
  );
  return {
    ...actual,
    withFileLock: withFileLockMock,
  };
});

let persistIdbToDisk: typeof import("./idb-persistence.js").persistIdbToDisk;
let restoreIdbFromDisk: typeof import("./idb-persistence.js").restoreIdbFromDisk;
type CapturedLockOptions =
  typeof import("./idb-persistence-lock.js").MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS;

beforeAll(async () => {
  ({ persistIdbToDisk, restoreIdbFromDisk } = await import("./idb-persistence.js"));
});

describe("Matrix IndexedDB persistence lock ordering", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-lock-order-"));
    withFileLockMock.mockReset();
    withFileLockMock.mockImplementation(
      async <T>(_filePath: string, _options: unknown, fn: () => Promise<T>) => await fn(),
    );
    await clearAllIndexedDbState();
  });

  afterEach(async () => {
    await clearAllIndexedDbState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures the snapshot after the file lock is acquired", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const dbName = "openclaw-matrix-test::matrix-sdk-crypto";
    await seedDatabase({
      name: dbName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "old-session" } }],
    });

    withFileLockMock.mockImplementationOnce(async (_filePath, _options, fn) => {
      await seedDatabase({
        name: dbName,
        storeName: "sessions",
        records: [{ key: "room-1", value: { session: "new-session" } }],
      });
      return await fn();
    });

    await persistIdbToDisk({ snapshotPath, databasePrefix: "openclaw-matrix-test" });

    const data = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Array<{
      stores: Array<{
        name: string;
        records: Array<{ key: IDBValidKey; value: { session: string } }>;
      }>;
    }>;
    const sessionsStore = data[0]?.stores.find((store) => store.name === "sessions");
    expect(sessionsStore?.records).toEqual([{ key: "room-1", value: { session: "new-session" } }]);
  });

  it("waits at least one persist interval before timing out on snapshot lock contention", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const capturedOptions: CapturedLockOptions[] = [];

    withFileLockMock.mockImplementationOnce(async (_filePath, options) => {
      capturedOptions.push(options as CapturedLockOptions);
      return 0;
    });
    await persistIdbToDisk({ snapshotPath, databasePrefix: "openclaw-matrix-test" });

    fs.writeFileSync(snapshotPath, "[]", "utf8");
    withFileLockMock.mockImplementationOnce(async (_filePath, options) => {
      capturedOptions.push(options as CapturedLockOptions);
      return false;
    });
    await restoreIdbFromDisk(snapshotPath);

    expect(capturedOptions).toHaveLength(2);
    for (const options of capturedOptions) {
      expect(computeMinimumRetryWindowMs(options.retries)).toBeGreaterThanOrEqual(
        MATRIX_IDB_PERSIST_INTERVAL_MS,
      );
      expect(options.stale).toBe(5 * 60_000);
    }
  });
});
