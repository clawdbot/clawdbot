import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  withOpenClawStateDatabaseInspectionSnapshots,
  withOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";

const writers: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    for (const writer of writers.splice(0)) {
      writer.close();
    }
    cleanup();
  });
});

describe("shared state database inspection snapshots", () => {
  it("reads committed WAL contents without touching the source shared-memory file", async () => {
    const databasePath = path.join(tempDirs.make("openclaw-state-inspection-"), "openclaw.sqlite");
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
    const rows = await withOpenClawStateDatabaseInspectionSnapshots(() =>
      withOpenClawStateDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT value FROM inspection_probe").all(),
        { path: databasePath },
      ),
    );
    const after = fs.statSync(shmPath, { bigint: true });

    expect(rows).toEqual([{ value: "committed-in-wal" }]);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.size).toBe(before.size);
  });
});
