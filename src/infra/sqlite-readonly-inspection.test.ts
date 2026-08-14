import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import {
  resolveSqliteReadOnlyInspectionLocation,
  withSqliteReadOnlyInspectionSnapshots,
} from "./sqlite-readonly-inspection.js";

const writers: Array<ReturnType<typeof openNodeSqliteDatabase>> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    for (const writer of writers.splice(0)) {
      writer.close();
    }
    cleanup();
  });
});

describe("SQLite read-only inspection snapshots", () => {
  it("preserves missing-source behavior without creating a snapshot", async () => {
    const databasePath = path.join(tempDirs.make("sqlite-inspection-missing-"), "missing.sqlite");

    const location = await withSqliteReadOnlyInspectionSnapshots(() =>
      resolveSqliteReadOnlyInspectionLocation(databasePath),
    );

    expect(location).toBe(databasePath);
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("reads committed WAL contents without touching the source shared-memory file", async () => {
    const databasePath = path.join(tempDirs.make("sqlite-inspection-"), "agent.sqlite");
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(databasePath);
    writers.push(writer);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE inspection_probe (value TEXT PRIMARY KEY);
      INSERT INTO inspection_probe VALUES ('committed-in-wal');
    `);

    const shmPath = `${databasePath}-shm`;
    const before = fs.statSync(shmPath, { bigint: true });
    const rows = await withSqliteReadOnlyInspectionSnapshots(() => {
      const first = resolveSqliteReadOnlyInspectionLocation(databasePath);
      const second = resolveSqliteReadOnlyInspectionLocation(databasePath);
      expect(second).toBe(first);
      const snapshot = openNodeSqliteDatabase(first, { readOnly: true });
      try {
        return snapshot.prepare("SELECT value FROM inspection_probe").all();
      } finally {
        snapshot.close();
      }
    });
    const after = fs.statSync(shmPath, { bigint: true });

    expect(rows).toEqual([{ value: "committed-in-wal" }]);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.size).toBe(before.size);
  });
});
