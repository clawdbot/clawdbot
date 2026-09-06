// Covers synchronous SQLite transaction helpers.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getNodeSqliteKysely } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransaction,
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

  it("preserves SQLITE_FULL and prevents caught nested failures from committing later writes", async () => {
    const tempDir = tempDirs.make("openclaw-sqlite-full-");
    const databasePath = path.join(tempDir, "full.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    openDatabases.push(db);
    db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value BLOB); PRAGMA max_page_count=3");
    let primaryError: unknown;
    let nestedError: unknown;
    let continuationError: unknown;
    let stagedValue = "before";
    const published: string[] = [];
    const stateEvents: string[] = [];
    const stage = (value: string) => {
      const previous = stagedValue;
      expect(
        stageSqliteTransactionState(db, {
          stage: () => {
            stagedValue = value;
          },
          rollback: () => {
            stagedValue = previous;
            stateEvents.push(`rollback:${value}`);
          },
          commit: () => {
            stateEvents.push(`commit:${value}`);
          },
        }),
      ).toBe(true);
      expect(deferSqlitePostCommitPublication(db, () => published.push(value))).toBe(true);
    };
    let outerError: unknown;
    try {
      withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare("INSERT INTO entries VALUES ('outer', 'kept only on commit')").run();
          stage("outer");
          try {
            withSqlitePostCommitPublications(db, () =>
              runSqliteImmediateTransactionSync(db, () => {
                stage("inner");
                try {
                  db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run();
                } catch (error) {
                  primaryError = error;
                  throw error;
                }
              }),
            );
          } catch (error) {
            nestedError = error;
          }
          // Even a caller that catches the failure cannot publish or autocommit
          // a continuation after SQLite has aborted the enclosing transaction.
          expect(stagedValue).toBe("before");
          try {
            db.prepare("INSERT INTO entries VALUES ('continuation', 'must not persist')").run();
          } catch (error) {
            continuationError = error;
          }
        }),
      );
    } catch (error) {
      outerError = error;
    }
    expect(primaryError).toMatchObject({ errcode: 13 });
    expect(nestedError).toBe(primaryError);
    expect(outerError).toBe(primaryError);
    expect(continuationError).toBeDefined();
    expect(db.isOpen).toBe(false);
    expect(stagedValue).toBe("before");
    expect(stateEvents).toEqual(["rollback:inner", "rollback:outer"]);
    expect(published).toEqual([]);
    let reuseError: unknown;
    try {
      runSqliteImmediateTransactionSync(db, () => undefined);
    } catch (error) {
      reuseError = error;
    }
    expect(reuseError).toBe(primaryError);
    const prepare = vi.fn(async () => () => undefined);
    await expect(runSqliteImmediateTransaction(db, prepare)).rejects.toBe(primaryError);
    expect(prepare).not.toHaveBeenCalled();

    const reopened = new DatabaseSync(databasePath);
    openDatabases.push(reopened);
    expect(readEntries(reopened)).toEqual([]);
    runSqliteImmediateTransactionSync(reopened, () => {
      reopened.prepare("INSERT INTO entries VALUES ('recovered', 'ok')").run();
    });
    expect(readEntries(reopened)).toEqual(["recovered"]);
    expect(reopened.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it.each(["ROLLBACK TO SAVEPOINT", "RELEASE SAVEPOINT"])(
    "closes the handle when nested %s cleanup fails and preserves the operation error",
    (failedStep) => {
      const db = createDatabase();
      const operationError = new Error("nested operation failed");
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql.startsWith(failedStep)) {
          throw new Error("injected cleanup failure");
        }
        exec(sql);
      });
      expect(() =>
        runSqliteImmediateTransactionSync(db, () => {
          expect(() =>
            runSqliteImmediateTransactionSync(db, () => {
              db.prepare("INSERT INTO entries VALUES ('inner', 'uncommitted')").run();
              throw operationError;
            }),
          ).toThrow(operationError);
        }),
      ).toThrow(operationError);
      expect(db.isOpen).toBe(false);
    },
  );

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

  it("clears cached state before closing after a rollback failure", () => {
    const execCalls: string[] = [];
    const operationError = new Error("operation failed");
    const rollbackError = new Error("rollback failed");
    let facadeAtClose: unknown;
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "ROLLBACK") {
          throw rollbackError;
        }
      },
      close() {
        facadeAtClose = getNodeSqliteKysely(db);
      },
    } as import("node:sqlite").DatabaseSync;
    const facadeBeforeClose = getNodeSqliteKysely(db);

    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        throw operationError;
      }),
    ).toThrow(operationError);
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    expect(facadeAtClose).toBeDefined();
    expect(facadeAtClose).not.toBe(facadeBeforeClose);
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

  it("does not warn for busyTimeoutMs: 0 with fast successful transactions (regression)", () => {
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const value = now;
      now += 5; // Fast: 5ms per step, well under the 1000ms default threshold
      return value;
    });
    const db = {
      exec() {},
    } as unknown as import("node:sqlite").DatabaseSync;

    runSqliteImmediateTransactionSync(db, () => "committed", {
      busyTimeoutMs: 0,
      databaseLabel: "agent.sqlite",
      logger,
      slowTransactionHoldMs: 0,
    });

    // busyTimeoutMs: 0 should NOT collapse threshold to 1ms.
    // With the default 1000ms threshold, 5ms steps are not slow.
    // Before the fix, this would have produced false-positive warnings.
    expect(logger.warn).not.toHaveBeenCalledWith(
      "slow SQLite transaction lock wait",
      expect.anything(),
    );
  });

  it("still warns for busyTimeoutMs: 0 when transaction crosses the default 1000ms threshold", () => {
    const logger = { warn: vi.fn() };
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const value = now;
      now += 1_500; // Genuinely slow: 1500ms per step
      return value;
    });
    const db = {
      exec() {},
    } as unknown as import("node:sqlite").DatabaseSync;

    runSqliteImmediateTransactionSync(db, () => "committed", {
      busyTimeoutMs: 0,
      databaseLabel: "agent.sqlite",
      logger,
      slowTransactionHoldMs: 0,
    });

    // The 1000ms default threshold still catches genuinely slow transactions.
    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction lock wait",
      expect.anything(),
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

describe("runSqliteImmediateTransaction", () => {
  it.each([true, false])(
    "preserves a failed nested rollback caught during preparation (write prepared: %s)",
    async (writePrepared) => {
      const db = createDatabase();
      db.exec("PRAGMA max_page_count=3");
      const write = vi.fn();
      let primaryError: unknown;
      const prepare = vi.fn(async () => {
        await Promise.resolve();
        try {
          runSqliteImmediateTransactionSync(db, () =>
            runSqliteImmediateTransactionSync(db, () =>
              db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run(),
            ),
          );
        } catch (error) {
          primaryError = error;
        }
        return writePrepared ? write : undefined;
      });
      let reportedError: unknown;
      try {
        await runSqliteImmediateTransaction(db, prepare);
      } catch (error) {
        reportedError = error;
      }
      expect(primaryError).toMatchObject({ errcode: 13 });
      expect(reportedError).toBe(primaryError);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(db.isOpen).toBe(false);
    },
  );

  it.each([false, true])(
    "preserves a failed rollback during admission yield (deadline expired: %s)",
    async (expireDeadline) => {
      const dir = tempDirs.make("openclaw-sqlite-admission-abort-");
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(path.join(dir, "index.sqlite"));
      const writer = new DatabaseSync(path.join(dir, "index.sqlite"));
      openDatabases.push(db, writer);
      const busyTimeoutMs = expireDeadline ? 100 : 1000;
      db.exec(`CREATE TABLE entries(id INTEGER PRIMARY KEY, value BLOB);
        PRAGMA max_page_count=2; PRAGMA busy_timeout=${busyTimeoutMs}`);
      writer.exec("BEGIN IMMEDIATE");
      let primaryError: unknown;
      let reportedError: unknown;
      let faultScheduled = false;
      let faultDone = Promise.resolve();
      const write = vi.fn(() =>
        db.prepare("INSERT INTO entries(value) VALUES ('unexpected')").run(),
      );
      const prepare = vi.fn(async () => {
        db.prepare("SELECT COUNT(*) FROM entries").get();
        if (!faultScheduled) {
          faultScheduled = true;
          faultDone = new Promise<void>((resolve) => {
            setImmediate(() => {
              try {
                writer.exec("ROLLBACK");
                runSqliteImmediateTransactionSync(db, () =>
                  runSqliteImmediateTransactionSync(db, () =>
                    db.prepare("INSERT INTO entries(value) VALUES (zeroblob(65536))").run(),
                  ),
                );
              } catch (error) {
                primaryError = error;
              } finally {
                // Keep the admission timer from resuming until its real deadline expires.
                if (expireDeadline) {
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, busyTimeoutMs + 20);
                }
                resolve();
              }
            });
          });
        }
        return write;
      });
      try {
        await runSqliteImmediateTransaction(db, prepare);
      } catch (error) {
        reportedError = error;
      }
      await faultDone;
      expect(primaryError).toMatchObject({ errcode: 13 });
      expect(reportedError).toBe(primaryError);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(db.isOpen).toBe(false);
      expect(writer.prepare("SELECT id FROM entries").all()).toEqual([]);
    },
  );

  it("repeats preparation and can decline a write while another writer remains active", async () => {
    const dir = tempDirs.make("openclaw-sqlite-preparation-");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(dir, "index.sqlite"));
    const writer = new DatabaseSync(path.join(dir, "index.sqlite"));
    openDatabases.push(db, writer);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE entries(id TEXT PRIMARY KEY);",
    );
    writer.exec("BEGIN IMMEDIATE");
    let eligible = true;
    let preparations = 0;
    const write = vi.fn(() => db.prepare("INSERT INTO entries VALUES ('unexpected')").run());
    const pending = runSqliteImmediateTransaction(db, async () => {
      preparations += 1;
      expect(db.isTransaction).toBe(false);
      return eligible ? write : undefined;
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(preparations).toBeGreaterThan(1));
      eligible = false;
      await expect(pending).resolves.toBeUndefined();
      expect(writer.isTransaction).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(db.prepare("SELECT id FROM entries").all()).toEqual([]);
      expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    } finally {
      writer.exec("ROLLBACK");
      await pending.catch(() => undefined);
    }
  });

  it.each(["existing", "preparation"])(
    "rejects a transaction from %s before admitting writes",
    async (owner) => {
      const db = createDatabase();
      const write = vi.fn();
      const prepare = vi.fn(async () => {
        db.exec("BEGIN");
        return write;
      });
      if (owner === "existing") {
        db.exec("BEGIN");
      }
      await expect(runSqliteImmediateTransaction(db, prepare)).rejects.toThrow(/transaction/);
      expect(prepare).toHaveBeenCalledTimes(owner === "existing" ? 0 : 1);
      expect(write).not.toHaveBeenCalled();
      expect(db.isTransaction).toBe(true);
      db.exec("ROLLBACK");
    },
  );

  it("prepares without holding a transaction and never replays an admitted write", async () => {
    const db = createDatabase();
    db.exec("PRAGMA busy_timeout = 50");
    const lockError = Object.assign(new Error("database is locked"), { errcode: 5 });
    let calls = 0;
    await expect(
      runSqliteImmediateTransaction(db, async () => {
        await Promise.resolve();
        expect(db.isTransaction).toBe(false);
        return () => {
          calls += 1;
          expect(db.isTransaction).toBe(true);
          expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(50);
          db.prepare("INSERT INTO entries(id, value) VALUES ('aborted', 'value')").run();
          throw lockError;
        };
      }),
    ).rejects.toBe(lockError);
    expect(calls).toBe(1);
    expect(readEntries(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });
});
