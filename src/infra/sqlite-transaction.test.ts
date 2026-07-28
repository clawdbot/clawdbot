// Covers synchronous SQLite transaction helpers.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];
type WriterLockChild = ChildProcessByStdio<null, Readable, Readable>;

const openChildren: WriterLockChild[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);");
  openDatabases.push(db);
  return db;
}

function readEntries(db: import("node:sqlite").DatabaseSync): string[] {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => (row as { id: string }).id);
}

function startWriterLockChild(databasePath: string, holdMs: number): WriterLockChild {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE;");
        process.stdout.write("ready\\n");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
        }, Number(process.argv[2]));
      `,
      databasePath,
      String(holdMs),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  openChildren.push(child);
  return child;
}

async function waitForChildReady(child: WriterLockChild): Promise<void> {
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk.toString();
    if (output.includes("ready")) {
      return;
    }
  }
  throw new Error(`writer-lock child exited before ready: ${output}`);
}

async function waitForChildExit(child: WriterLockChild): Promise<void> {
  if (child.exitCode !== null) {
    expect(child.exitCode).toBe(0);
    return;
  }
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  expect(result).toEqual({ code: 0, stderr: "" });
}

afterEach(() => {
  for (const child of openChildren.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  vi.restoreAllMocks();
});

describe("runSqliteDeferredTransactionSync", () => {
  it("keeps multiple reads on one snapshot while another connection commits", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-read-snapshot-");
    const databasePath = path.join(tempDir, "snapshot.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const reader = new DatabaseSync(databasePath);
    const writer = new DatabaseSync(databasePath);
    openDatabases.push(reader, writer);
    reader.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY); INSERT INTO entries VALUES ('first');",
    );
    writer.exec("PRAGMA busy_timeout = 1000;");

    const counts = runSqliteDeferredTransactionSync(reader, () => {
      const before = reader.prepare("SELECT COUNT(*) AS count FROM entries").get() as {
        count: number;
      };
      writer.prepare("INSERT INTO entries(id) VALUES (?)").run("second");
      const after = reader.prepare("SELECT COUNT(*) AS count FROM entries").get() as {
        count: number;
      };
      return [before.count, after.count];
    });

    expect(counts).toEqual([1, 1]);
    expect(writer.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 2 });
  });
});

describe("runSqliteImmediateTransactionSync", () => {
  it("keeps outer writes when a nested savepoint rolls back", () => {
    const db = createDatabase();

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      expect(() =>
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "rolled back");
          throw new Error("nested failure");
        }),
      ).toThrow("nested failure");
    });

    expect(readEntries(db)).toEqual(["outer"]);
  });

  it("commits nested savepoint writes with the outer transaction", () => {
    const db = createDatabase();

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "kept");
      });
    });

    expect(readEntries(db)).toEqual(["inner", "outer"]);
  });

  it("rejects Promise-returning operations and rolls back their synchronous writes", () => {
    const db = createDatabase();

    expect(() =>
      runSqliteImmediateTransactionSync(db, async () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("async", "rolled back");
        return "done";
      }),
    ).toThrow("must be synchronous");
    expect(readEntries(db)).toEqual([]);

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("after", "works");
    });
    expect(readEntries(db)).toEqual(["after"]);
  });

  it("does not retry commit failures and rolls back the transaction", () => {
    const execCalls: string[] = [];
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "COMMIT") {
          throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
        }
      },
      close() {},
    } as import("node:sqlite").DatabaseSync;

    expect(() => runSqliteImmediateTransactionSync(db, () => "not committed")).toThrow(
      "database is busy",
    );
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
  });

  it("logs one structured warning for a terminal lock failure", () => {
    const execCalls: string[] = [];
    const logger = { warn: vi.fn() };
    const lockError = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
    });
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "BEGIN IMMEDIATE") {
          throw lockError;
        }
      },
    } as import("node:sqlite").DatabaseSync;

    expect(() =>
      runSqliteImmediateTransactionSync(db, () => "blocked", {
        busyTimeoutMs: 5_000,
        databaseLabel: "agent.sqlite",
        logger,
        operationLabel: "session.patch",
      }),
    ).toThrow(lockError);
    expect(execCalls).toEqual(["BEGIN IMMEDIATE"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "SQLite transaction lock wait failed",
      expect.objectContaining({
        async: false,
        busyTimeoutMs: 5_000,
        code: "ERR_SQLITE_ERROR",
        database: "agent.sqlite",
        failureKind: "lock-contention",
        operation: "session.patch",
        pid: process.pid,
        sqliteErrcode: 5,
        sqlitePrimaryCode: 5,
        step: "begin",
      }),
    );
  });

  it("logs slow successful transaction lock waits", () => {
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const value = now;
      now += 1_500;
      return value;
    });
    const db = {
      exec() {},
    } as unknown as import("node:sqlite").DatabaseSync;

    runSqliteImmediateTransactionSync(db, () => "committed", {
      busyTimeoutMs: 5_000,
      databaseLabel: "agent.sqlite",
      logger,
      slowTransactionHoldMs: 0,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction lock wait",
      expect.objectContaining({
        async: false,
        database: "agent.sqlite",
        elapsedMs: 1_500,
        pid: process.pid,
        step: "begin",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction lock wait",
      expect.objectContaining({
        async: false,
        database: "agent.sqlite",
        elapsedMs: 1_500,
        pid: process.pid,
        step: "commit",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction hold",
      expect.objectContaining({
        async: false,
        database: "agent.sqlite",
        pid: process.pid,
      }),
    );
  });

  it("waits for a separate writer and exposes the synchronous event-loop cost", async () => {
    const holdMs = 200;
    const tempDir = tempDirs.make("openclaw-sqlite-contention-");
    const databasePath = path.join(tempDir, "contention.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    openDatabases.push(db);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000; CREATE TABLE entries (id TEXT PRIMARY KEY);",
    );
    const child = startWriterLockChild(databasePath, holdMs);
    await waitForChildReady(child);

    let timerFiredAt: number | undefined;
    const timerStartedAt = Date.now();
    setTimeout(() => {
      timerFiredAt = Date.now();
    }, 0);
    const transactionStartedAt = Date.now();
    runSqliteImmediateTransactionSync(
      db,
      () => db.prepare("INSERT INTO entries(id) VALUES (?)").run("parent"),
      { busyTimeoutMs: 1_000 },
    );
    const elapsedMs = Date.now() - transactionStartedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(Math.floor(holdMs / 2));
    expect(timerFiredAt).toBeUndefined();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect((timerFiredAt ?? 0) - timerStartedAt).toBeGreaterThanOrEqual(Math.floor(holdMs / 2));
    await waitForChildExit(child);
    expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "parent" }]);
  });

  it("fails a real separate-writer wait after the single SQLite busy timeout", async () => {
    const tempDir = tempDirs.make("openclaw-sqlite-timeout-");
    const databasePath = path.join(tempDir, "contention.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    openDatabases.push(db);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 20; CREATE TABLE entries (id TEXT PRIMARY KEY);",
    );
    const child = startWriterLockChild(databasePath, 250);
    await waitForChildReady(child);

    const logger = { warn: vi.fn() };
    const startedAt = Date.now();
    let thrown: unknown;
    try {
      runSqliteImmediateTransactionSync(db, () => undefined, {
        busyTimeoutMs: 20,
        databaseLabel: databasePath,
        logger,
        operationLabel: "contention-proof",
      });
    } catch (error) {
      thrown = error;
    }
    const elapsedMs = Date.now() - startedAt;
    expect(thrown).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(200);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "SQLite transaction lock wait failed",
      expect.objectContaining({
        busyTimeoutMs: 20,
        code: "ERR_SQLITE_ERROR",
        failureKind: "lock-contention",
        operation: "contention-proof",
        sqliteErrcode: 5,
        sqlitePrimaryCode: 5,
        step: "begin",
      }),
    );

    await waitForChildExit(child);
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries(id) VALUES (?)").run("after-timeout");
      }),
    ).not.toThrow();
  });
});
