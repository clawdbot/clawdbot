import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

async function holdStateCoordinator(databasePath: string) {
  // Initialize the real coordinator location/permissions through its owner.
  const coordinator = acquireStateDatabaseCoordinator({ databasePath });
  const coordinatorPath = coordinator.path;
  coordinator.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(coordinatorPath)});
    db.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
    process.send({ ready: true });
    process.once("message", () => {
      db.exec("ROLLBACK");
      db.close();
      process.disconnect();
    });
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    expect(message).toEqual({ ready: true });
  } catch (error) {
    await stopChildProcess(child, 5_000);
    throw error;
  }
  return async () => {
    try {
      const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
      child.send({ release: true });
      await closed;
    } finally {
      await stopChildProcess(child, 5_000);
    }
  };
}

function sqliteBytes(databasePath: string) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const file = databasePath + suffix;
      return [suffix, fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null];
    }),
  );
}

describe("shared-state transaction lifecycle participation", () => {
  it.each(["path", "all"] as const)(
    "refuses %s retirement before checkpoint or close while another process owns lifecycle exclusion",
    async (scope) => {
      const root = tempDirs.make("openclaw-state-close-coordinator-");
      const options = { path: path.join(root, "openclaw.sqlite") };
      const database = openOpenClawStateDatabase(options);
      runOpenClawStateWriteTransaction((owner) => {
        owner.db
          .prepare(
            "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
          )
          .run("retirement", "retained", "{}", 1);
      }, options);
      const retire = () =>
        scope === "path"
          ? closeOpenClawStateDatabaseByPath(database.path)
          : closeOpenClawStateDatabase();
      const release = await holdStateCoordinator(database.path);
      const before = sqliteBytes(database.path);
      try {
        expect(retire).toThrow(/state-lifecycle/);
        expect(database.db.isOpen).toBe(true);
        expect(sqliteBytes(database.path)).toEqual(before);
      } finally {
        await release();
      }
      // Refusal retains the actual cache owner; retry closes it only after exclusion ends.
      expect(openOpenClawStateDatabase(options)).toBe(database);
      retire();
      expect(database.db.isOpen).toBe(false);
      const reopened = openOpenClawStateDatabase(options);
      expect(
        reopened.db
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
          .all("retirement"),
      ).toEqual([{ event_key: "retained" }]);
    },
  );

  it("refuses a savepoint in an uncoordinated enclosing transaction", () => {
    const root = tempDirs.make("openclaw-state-uncoordinated-parent-");
    const options = { path: path.join(root, "openclaw.sqlite") };
    const database = openOpenClawStateDatabase(options);
    const callback = vi.fn();
    database.db.exec("BEGIN IMMEDIATE");
    try {
      expect(() => runOpenClawStateWriteTransaction(callback, { ...options, database })).toThrow(
        /uncoordinated.*transaction/i,
      );
      expect(callback).not.toHaveBeenCalled();
      expect(database.db.isTransaction).toBe(true);
    } finally {
      database.db.exec("ROLLBACK");
    }
  });

  it.each(["cached", "supplied"] as const)(
    "refuses a %s writer while another process holds lifecycle exclusion and resumes after release",
    async (handle) => {
      const root = tempDirs.make("openclaw-state-writer-coordinator-");
      const options = { path: path.join(root, "openclaw.sqlite") };
      const database = openOpenClawStateDatabase(options);
      const writeOptions = handle === "supplied" ? { ...options, database } : options;
      const callback = vi.fn(() => {
        database.db
          .prepare(
            "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
          )
          .run("coordinator", "committed", "{}", 1);
      });
      const release = await holdStateCoordinator(database.path);
      const before = sqliteBytes(database.path);
      try {
        expect(() =>
          runOpenClawStateWriteTransaction(callback, writeOptions, { busyTimeoutMs: 0 }),
        ).toThrow(/state-lifecycle/);
        expect(callback).not.toHaveBeenCalled();
        expect(sqliteBytes(database.path)).toEqual(before);
        expect(database.db.isTransaction).toBe(false);
      } finally {
        await release();
      }
      runOpenClawStateWriteTransaction(callback, writeOptions, { busyTimeoutMs: 0 });
      expect(callback).toHaveBeenCalledOnce();
      expect(
        database.db
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
          .all("coordinator"),
      ).toEqual([{ event_key: "committed" }]);
    },
  );
});
