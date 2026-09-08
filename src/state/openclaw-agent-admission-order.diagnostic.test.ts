// Synthetic canonical admission ordering and lifecycle proof; checks use real native SQLite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqlite from "../infra/node-sqlite.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import * as pidAlive from "../shared/pid-alive.js";
import * as agentLeases from "./openclaw-agent-db-lease.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  disposeOpenClawAgentDatabaseByPath,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
  runOpenClawAgentWriteTransaction,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

// Most cases inspect one returned handle after the scoped operation, without
// competing opens. Retention tests keep their work inside the actual owner.
function openOpenClawAgentDatabaseAsync(options: Parameters<typeof openOpenClawAgentDatabase>[0]) {
  return withOpenClawAgentDatabaseAsync(options, (database) => database);
}

const roots: string[] = [];
const independent: DatabaseSync[] = [];
const realOpen = sqlite.openNodeSqliteDatabase;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of independent.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-open-order-"));
  roots.push(root);
  const options = { agentId: "synthetic-owner", env: { OPENCLAW_STATE_DIR: root } };
  openOpenClawStateDatabase({ env: options.env });
  const database = openOpenClawAgentDatabase(options);
  database.db.exec(`
    INSERT INTO memory_index_chunks
      (id,path,start_line,end_line,hash,model,text,embedding,updated_at)
      VALUES ('synthetic-parent','synthetic',1,1,'hash','synthetic','text','[]',1);
    INSERT INTO memory_index_chunk_recall_metadata (chunk_id, importance)
      VALUES ('synthetic-parent',1);
  `);
  expect(database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const pathname = database.path;
  closeOpenClawAgentDatabasesForTest();
  const writer = realOpen(pathname);
  independent.push(writer);
  writer.exec("PRAGMA foreign_keys=OFF;");
  return { options, pathname, writer };
}

function corruptForeignKey(writer: DatabaseSync) {
  writer.exec("DELETE FROM memory_index_chunks WHERE id='synthetic-parent';");
  expect(writer.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
}

function commitAfterCheck(pathname: string, gate: "integrity" | "foreign-key", commit: () => void) {
  let completed = false;
  const events: string[] = [];
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
    const db = realOpen(location, options);
    if (location !== pathname) {
      return db;
    }
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA integrity_check;") {
        const all = statement.all.bind(statement);
        statement.all = () => {
          const rows = all();
          events.push("integrity-completed");
          if (!completed && gate === "integrity") {
            completed = true;
            commit();
            events.push("external-commit");
          }
          return rows;
        };
      }
      if (sql === "PRAGMA foreign_key_check;") {
        const iterate = statement.iterate.bind(statement);
        statement.iterate = function* () {
          yield* iterate();
          events.push("foreign-key-completed");
          if (!completed && gate === "foreign-key") {
            completed = true;
            commit();
            events.push("external-commit");
          }
          return undefined;
        };
      }
      return statement;
    };
    return db;
  });
  return { events, didCommit: () => completed };
}

function ordinaryWrite(options: Parameters<typeof openOpenClawAgentDatabase>[0]) {
  return runOpenClawAgentWriteTransaction((database) => {
    database.db
      .prepare(
        "INSERT INTO cache_entries (scope,key,value_json,updated_at) VALUES ('synthetic','proof','{}',1)",
      )
      .run();
    return database.db
      .prepare("SELECT count(*) AS n FROM cache_entries WHERE scope='synthetic'")
      .get();
  }, options);
}

describe("physical-open admission ordering", () => {
  it("rejects an external FK violation committed between full integrity and FK checks", () => {
    const { options, pathname, writer } = seed();
    const trace = commitAfterCheck(pathname, "integrity", () => corruptForeignKey(writer));
    expect(() => openOpenClawAgentDatabase(options)).toThrow(/foreign_key_check failed/);
    expect(trace.events).toEqual([
      "integrity-completed",
      "external-commit",
      "foreign-key-completed",
    ]);
  });

  it("exposes and writes after an external FK violation committed after the FK check", () => {
    const { options, pathname, writer } = seed();
    const trace = commitAfterCheck(pathname, "foreign-key", () => corruptForeignKey(writer));
    const database = openOpenClawAgentDatabase(options);
    expect(trace.events).toEqual([
      "integrity-completed",
      "foreign-key-completed",
      "external-commit",
    ]);
    expect(database.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    expect(ordinaryWrite(options)).toEqual({ n: 1 });
  });

  it("trusts a live cached handle but rejects the same FK violation after physical reopen", () => {
    const { options, pathname, writer } = seed();
    const first = openOpenClawAgentDatabase(options);
    corruptForeignKey(writer);
    expect(openOpenClawAgentDatabase(options)).toBe(first);
    expect(ordinaryWrite(options)).toEqual({ n: 1 });
    expect(closeOpenClawAgentDatabaseByPath(pathname)).toBe(true);
    expect(() => openOpenClawAgentDatabase(options)).toThrow(/foreign_key_check failed/);
  });

  it.each(["agent-id", "role", "version"] as const)(
    "rejects concurrent %s replacement after the physical checks before exposure",
    (replacement) => {
      const { options, pathname, writer } = seed();
      const trace = commitAfterCheck(pathname, "foreign-key", () => {
        if (replacement === "agent-id") {
          writer.exec("UPDATE schema_meta SET agent_id='replacement' WHERE meta_key='primary'");
        } else if (replacement === "role") {
          writer.exec("UPDATE schema_meta SET role='global' WHERE meta_key='primary'");
        } else {
          writer.exec("PRAGMA user_version=9999;");
        }
      });
      expect(() => openOpenClawAgentDatabase(options)).toThrow(
        /belongs to agent replacement|schema role global|schema version 9999/,
      );
      expect(trace.didCommit()).toBe(true);
      expect(
        writer.prepare("SELECT count(*) AS n FROM cache_entries WHERE scope='synthetic'").get(),
      ).toEqual({ n: 0 });
    },
  );
});

describe("asynchronous canonical admission", () => {
  it("observes an independent WAL commit between the Worker's integrity and FK checks", async () => {
    const { pathname, writer } = seed();
    const control = new SharedArrayBuffer(4);
    const worker = new Worker(
      new URL(
        `data:text/javascript,${encodeURIComponent(`
        import { DatabaseSync } from "node:sqlite";
        import { parentPort, workerData } from "node:worker_threads";
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function (sql) {
          const statement = prepare.call(this, sql);
          if (sql === "PRAGMA integrity_check;") {
            const all = statement.all.bind(statement);
            statement.all = () => {
              const rows = all();
              parentPort.postMessage({ phase: "after-integrity" });
              if (Atomics.wait(new Int32Array(workerData.control), 0, 0, 30000) === "timed-out") {
                throw new Error("fixture did not commit between integrity and FK checks");
              }
              return rows;
            };
          }
          return statement;
        };
        await import(workerData.entry);
      `)}`,
      ),
      {
        workerData: {
          pathname,
          identity: integrityWorker.readSqliteIntegrityFileIdentity(pathname),
          busyTimeoutMs: 5000,
          control,
          entry: new URL("../infra/sqlite-integrity.worker.ts", import.meta.url).href,
        },
        execArgv: ["--import", "tsx"],
      },
    );
    let committed = false;
    const completed = new Promise<integrityWorker.SqliteIntegrityWorkerResult>(
      (resolve, reject) => {
        let result: integrityWorker.SqliteIntegrityWorkerResult | undefined;
        worker.on(
          "message",
          (message: integrityWorker.SqliteIntegrityWorkerResult | { phase: string }) => {
            if ("phase" in message) {
              try {
                // The independent fixture writer disables FK enforcement deliberately;
                // this pins check visibility, not an ordinary writer corruption claim.
                corruptForeignKey(writer);
                committed = true;
              } catch (error) {
                reject(toStringifiedError(error));
              } finally {
                Atomics.store(new Int32Array(control), 0, 1);
                Atomics.notify(new Int32Array(control), 0);
              }
            } else {
              result = message;
            }
          },
        );
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code === 0 && result) {
            resolve(result);
          } else {
            reject(new Error(`integrity fixture exited ${code} without its result`));
          }
        });
      },
    );
    try {
      await expect(completed).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("foreign_key_check failed") },
      });
      expect(committed).toBe(true);
    } finally {
      await worker.terminate();
    }
  });

  it("does not revoke another owner's pending admission while closing a registered path", async () => {
    const { options, pathname } = seed();
    const opening = openOpenClawAgentDatabaseAsync(options);
    expect(closeOpenClawAgentDatabaseByPath(pathname, "foreign-owner")).toBe(false);
    const database = await opening;
    expect(database.db.isOpen).toBe(true);
    expect(closeOpenClawAgentDatabaseByPath(pathname, options.agentId)).toBe(true);
    expect(database.db.isOpen).toBe(false);
  });

  it("keeps failed lease cleanup with its original agent owner", async () => {
    const { options, pathname, writer } = seed();
    const state = openOpenClawStateDatabase({ env: options.env });
    writer.exec("PRAGMA user_version=999;");
    state.db.exec(`CREATE TEMP TRIGGER fail_owned_release BEFORE DELETE ON agent_database_leases
      BEGIN SELECT RAISE(ABORT, 'synthetic blocked release'); END`);
    try {
      await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
        "synthetic blocked release",
      );
    } finally {
      state.db.exec("DROP TRIGGER fail_owned_release");
    }
    const leases = () => state.db.prepare("SELECT lease_id FROM agent_database_leases;").all();
    expect(leases()).toHaveLength(1);
    expect(closeOpenClawAgentDatabaseByPath(pathname, "foreign-owner")).toBe(false);
    expect(leases()).toHaveLength(1);
    closeOpenClawAgentDatabaseByPath(pathname, options.agentId);
    expect(leases()).toEqual([]);
  });

  it.each([null, 1])(
    "preserves process-start identity semantics across await (initial: %s)",
    async (initial) => {
      const { options } = seed();
      const identity = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(initial);
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (...args) => {
          await check(...args);
          identity.mockReturnValue(2);
        },
      );
      const opening = openOpenClawAgentDatabaseAsync(options);
      if (initial === null) {
        await expect(opening).resolves.toMatchObject({ agentId: options.agentId });
      } else {
        await expect(opening).rejects.toThrow(/lost its runtime lease/);
      }
    },
  );

  it("rejects a lost original lease before publishing the checked handle", async () => {
    const { options, pathname } = seed();
    const state = openOpenClawStateDatabase({ env: options.env });
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
      async (...args) => {
        await check(...args);
        const lease = state.db
          .prepare("SELECT lease_id FROM agent_database_leases WHERE path=?")
          .get(pathname);
        expect(lease).toBeDefined();
        releaseOpenClawAgentDatabaseLease(String(lease?.lease_id), { env: options.env });
      },
    );
    await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(/lost its runtime lease/);
    expect(state.db.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
  });

  it.each([false, true])(
    "preserves physical index repair policy (unrelated damage: %s)",
    async (unrelated) => {
      const { options, writer } = seed();
      writer.exec(`
      INSERT INTO cache_entries (scope,key,value_json,expires_at,updated_at)
      VALUES ('scope-a','key-a','{}',100,1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
      if (unrelated) {
        writer.exec(`
        CREATE TABLE unsafe_records (id INTEGER PRIMARY KEY, value TEXT, alternate TEXT);
        CREATE INDEX unsafe_records_value ON unsafe_records(value);
        INSERT INTO unsafe_records (value,alternate) VALUES ('alpha','zeta'),('beta','eta');
      `);
      }
      writer.enableDefensive?.(false);
      writer.exec("PRAGMA writable_schema=ON;");
      writer.exec(`UPDATE sqlite_schema SET sql=
      'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
      WHERE name='idx_agent_cache_expiry';`);
      if (unrelated) {
        writer.exec(`UPDATE sqlite_schema SET sql=
        'CREATE INDEX unsafe_records_value ON unsafe_records(alternate)'
        WHERE name='unsafe_records_value';`);
      }
      const version = Number(writer.prepare("PRAGMA schema_version").get()?.schema_version);
      writer.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${version + 1};`);
      expect(writer.prepare("PRAGMA integrity_check").all()).not.toEqual([
        { integrity_check: "ok" },
      ]);
      writer.close();
      if (unrelated) {
        await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
          /integrity_check failed/,
        );
      } else {
        const database = await openOpenClawAgentDatabaseAsync(options);
        expect(database.db.prepare("PRAGMA integrity_check").all()).toEqual([
          { integrity_check: "ok" },
        ]);
        expect(ordinaryWrite(options)).toEqual({ n: 1 });
      }
    },
  );

  it.each([false, true])("retains its state owner across await (ambient: %s)", async (ambient) => {
    const { options, pathname } = seed();
    const originalEnv = { ...options.env };
    const nextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-open-next-owner-"));
    roots.push(nextRoot);
    const state = openOpenClawStateDatabase({ env: originalEnv });
    const leases = () => state.db.prepare("SELECT lease_id FROM agent_database_leases").all();
    vi.stubEnv("OPENCLAW_STATE_DIR", originalEnv.OPENCLAW_STATE_DIR);
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
      async (...args) => {
        const work = check(...args);
        options.env.OPENCLAW_STATE_DIR = nextRoot;
        vi.stubEnv("OPENCLAW_STATE_DIR", nextRoot);
        await work;
      },
    );
    try {
      const opening = openOpenClawAgentDatabaseAsync({
        agentId: options.agentId,
        path: pathname,
        ...(ambient ? {} : { env: options.env }),
      });
      await expect(opening).resolves.toMatchObject({ path: pathname });
      expect(leases()).toHaveLength(1);
      closeOpenClawAgentDatabaseByPath(pathname);
      expect(leases()).toEqual([]);
      expect(fs.readdirSync(nextRoot)).toEqual([]);
    } finally {
      options.env.OPENCLAW_STATE_DIR = originalEnv.OPENCLAW_STATE_DIR;
      vi.stubEnv("OPENCLAW_STATE_DIR", originalEnv.OPENCLAW_STATE_DIR);
      for (const lease of leases()) {
        releaseOpenClawAgentDatabaseLease(String(lease.lease_id), { env: originalEnv });
      }
    }
  });

  it.each(["new", "registered replacement", "disposed replacement"] as const)(
    "initializes a %s database after read-only physical admission",
    async (mode) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-open-empty-"));
      roots.push(root);
      const options = { agentId: "synthetic-new", env: { OPENCLAW_STATE_DIR: root } };
      if (mode !== "new") {
        const original = openOpenClawAgentDatabase(options);
        if (mode === "disposed replacement") {
          expect(disposeOpenClawAgentDatabaseByPath(original.path, { env: options.env })).toBe(
            true,
          );
        } else {
          closeOpenClawAgentDatabaseByPath(original.path);
        }
        fs.renameSync(path.dirname(original.path), `${path.dirname(original.path)}-retired`);
      }
      const check = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
      const database = await openOpenClawAgentDatabaseAsync(options);
      expect(check).toHaveBeenCalledOnce();
      expect(database.db.prepare("SELECT agent_id FROM schema_meta").get()).toEqual({
        agent_id: options.agentId,
      });
      expect(ordinaryWrite(options)).toEqual({ n: 1 });
      expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([
        expect.objectContaining({ agentId: options.agentId, path: database.path }),
      ]);
    },
  );

  it("keeps the incognito handle in memory without starting a disk checker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-open-incognito-"));
    roots.push(root);
    const options = { agentId: "synthetic-private", env: { OPENCLAW_STATE_DIR: root } };
    const pathname = resolveIncognitoOpenClawAgentSqlitePath(options);
    const check = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const database = await openOpenClawAgentDatabaseAsync({ ...options, path: pathname });
    expect(openOpenClawAgentDatabase({ ...options, path: pathname })).toBe(database);
    expect(check).not.toHaveBeenCalled();
    expect(fs.existsSync(pathname)).toBe(false);
  });

  it("checks an older schema before the unchanged doctor migration refusal", async () => {
    const { options, writer } = seed();
    writer.exec("PRAGMA user_version=18; UPDATE schema_meta SET schema_version=18;");
    const check = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
      /uses schema version 18; stop active agents/,
    );
    expect(check).toHaveBeenCalledOnce();
    expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
  });

  it("publishes one healthy native handle shared with ordinary synchronous writes", async () => {
    const { options } = seed();
    const check = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const [database, sameDatabase] = await Promise.all([
      openOpenClawAgentDatabaseAsync(options),
      openOpenClawAgentDatabaseAsync(options),
    ]);
    expect(sameDatabase).toBe(database);
    expect(check).toHaveBeenCalledOnce();
    expect(openOpenClawAgentDatabase(options)).toBe(database);
    expect(ordinaryWrite(options)).toEqual({ n: 1 });
  });

  it("preserves point-in-time admission when a writer commits after the Worker check", async () => {
    const { options, writer } = seed();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
      async (...args) => {
        await check(...args);
        corruptForeignKey(writer);
      },
    );
    const database = await openOpenClawAgentDatabaseAsync(options);
    expect(database.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    expect(ordinaryWrite(options)).toEqual({ n: 1 });
  });

  it.each(["agent-id", "role", "version"] as const)(
    "rejects %s replacement after Worker completion before exposure",
    async (replacement) => {
      const { options, writer } = seed();
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (...args) => {
          await check(...args);
          if (replacement === "agent-id") {
            writer.exec("UPDATE schema_meta SET agent_id='replacement'");
          } else if (replacement === "role") {
            writer.exec("UPDATE schema_meta SET role='global'");
          } else {
            writer.exec("PRAGMA user_version=9999;");
          }
        },
      );
      await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
        /belongs to agent replacement|schema role global|schema version 9999/,
      );
      expect(() =>
        assertNoOpenClawAgentDatabaseLeases(options.agentId, { env: options.env }),
      ).not.toThrow();
    },
  );

  it("reopens an evicted validated database while a WAL writer remains active", async () => {
    const { options, pathname, writer } = seed();
    openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabaseByPath(pathname);
    writer.exec("BEGIN IMMEDIATE;");
    try {
      expect((await openOpenClawAgentDatabaseAsync(options)).db.isOpen).toBe(true);
      expect(writer.isTransaction).toBe(true);
    } finally {
      writer.exec("ROLLBACK;");
    }
    expect(ordinaryWrite(options)).toEqual({ n: 1 });
  });

  it("rejects an existing FK violation before publishing a writable handle", async () => {
    const { options, writer } = seed();
    corruptForeignKey(writer);
    await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
      /foreign_key_check failed/,
    );
    expect(() =>
      assertNoOpenClawAgentDatabaseLeases(options.agentId, { env: options.env }),
    ).not.toThrow();
    expect(
      writer.prepare("SELECT count(*) AS n FROM cache_entries WHERE scope='synthetic'").get(),
    ).toEqual({ n: 0 });
  });

  it("rechecks corruption on async physical reopen", async () => {
    const { options, pathname, writer } = seed();
    await openOpenClawAgentDatabaseAsync(options);
    expect(closeOpenClawAgentDatabaseByPath(pathname)).toBe(true);
    corruptForeignKey(writer);
    await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
      /foreign_key_check failed/,
    );
  });

  it("joins the real read-only Worker before releasing a revoked admission lease", async () => {
    const { options, writer } = seed();
    writer.exec(
      "INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('load','large',zeroblob(8388608),1)",
    );
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    let drain: Promise<void> | undefined;
    let completed = false;
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation((...args) => {
      const native = check(...args).finally(() => {
        completed = true;
      });
      drain = closeOpenClawAgentDatabasesAsync(options.env.OPENCLAW_STATE_DIR);
      expect(completed).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeases(options.agentId, { env: options.env }),
      ).toThrow(/still open/);
      return native;
    });
    await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(/revoked/);
    await drain;
    expect(completed).toBe(true);
    expect(() =>
      assertNoOpenClawAgentDatabaseLeases(options.agentId, { env: options.env }),
    ).not.toThrow();
    writer.exec("BEGIN IMMEDIATE; ROLLBACK;");
  });

  it("keeps the parent event loop responsive while checking a populated canonical database", async () => {
    const { options, writer } = seed();
    writer.exec(
      "INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('load','large',zeroblob(16777216),1)",
    );
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      const database = await openOpenClawAgentDatabaseAsync(options);
      expect(database.db.isOpen).toBe(true);
      expect(ticks).toBeGreaterThan(0);
      expect(ordinaryWrite(options)).toEqual({ n: 1 });
    } finally {
      clearInterval(timer);
    }
  });

  it.each([false, true])(
    "preserves a synchronous replacement when old async close fails=%s",
    async (failClose) => {
      const { options, pathname, writer } = seed();
      writer.exec(
        "INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('load','large',zeroblob(8388608),1)",
      );
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      let source: DatabaseSync | undefined;
      let replacement: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
      vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((location, dbOptions) => {
        const db = realOpen(location, dbOptions);
        if (location === pathname && !source) {
          source = db;
        }
        return db;
      });
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation((...args) => {
        const native = check(...args);
        replacement = openOpenClawAgentDatabase(options);
        if (failClose && source) {
          const close = source.close.bind(source);
          let failed = false;
          source.close = () => {
            if (!failed) {
              failed = true;
              throw new Error("synthetic native close failure");
            }
            close();
          };
        }
        return native;
      });
      await expect(openOpenClawAgentDatabaseAsync(options)).rejects.toThrow(
        failClose ? /synthetic native close failure/ : /revoked/,
      );
      expect(replacement?.db.isOpen).toBe(true);
      expect(openOpenClawAgentDatabase(options)).toBe(replacement);
      expect(ordinaryWrite(options)).toEqual({ n: 1 });
      expect(source?.isOpen).toBe(failClose);
      expect(closeOpenClawAgentDatabaseByPath(pathname)).toBe(true);
      expect(source?.isOpen).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeases(options.agentId, { env: options.env }),
      ).not.toThrow();
    },
  );
});

describe("failed-open cleanup ownership", () => {
  it.each(["sync", "async"] as const)(
    "retains the original failed lease release for retry (%s)",
    async (mode) => {
      const { options, pathname } = seed();
      const originalEnv = { ...options.env };
      const state = openOpenClawStateDatabase({ env: originalEnv });
      const rows = () => state.db.prepare("SELECT lease_id FROM agent_database_leases;").all();
      const release = vi.spyOn(agentLeases, "releaseOpenClawAgentDatabaseLease");
      release.mockImplementation(() => {
        throw new Error("synthetic lease release failure");
      });
      if (mode === "sync") {
        expect(() =>
          openOpenClawAgentDatabase({ ...options, agentId: "other-owner", path: pathname }),
        ).toThrow("synthetic lease release failure");
      } else {
        const admission = openOpenClawAgentDatabaseAsync(options);
        await Promise.all([
          expect(admission).rejects.toThrow("synthetic lease release failure"),
          expect(closeOpenClawAgentDatabasesAsync()).rejects.toThrow(
            "synthetic lease release failure",
          ),
        ]);
      }
      expect(rows()).toHaveLength(1);
      const originalLease = rows()[0];
      const nextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-close-next-owner-"));
      roots.push(nextRoot);
      options.env.OPENCLAW_STATE_DIR = nextRoot;
      await expect(closeOpenClawAgentDatabasesAsync()).rejects.toThrow(
        "synthetic lease release failure",
      );
      expect(rows()).toEqual([originalLease]);
      release.mockRestore();
      await closeOpenClawAgentDatabasesAsync();
      expect(rows()).toEqual([]);
      expect(fs.readdirSync(nextRoot)).toEqual([]);
    },
  );
});

it("checks the original lease while another shared-state WAL writer is active", () => {
  const { options } = seed();
  const database = openOpenClawAgentDatabase(options);
  const state = openOpenClawStateDatabase({ env: options.env });
  const row = state.db.prepare("SELECT lease_id FROM agent_database_leases;").get() as {
    lease_id: string;
  };
  const blocker = realOpen(state.path);
  independent.push(blocker);
  blocker.exec("BEGIN IMMEDIATE;");
  try {
    expect(() =>
      agentLeases.assertOpenClawAgentDatabaseLease(row.lease_id, {
        agentId: database.agentId,
        path: database.path,
        env: options.env,
      }),
    ).not.toThrow();
  } finally {
    blocker.exec("ROLLBACK;");
  }
});

it("joins only the pending admissions in the closing runtime root", async () => {
  const first = seed();
  const second = seed();
  const firstOpen = openOpenClawAgentDatabaseAsync(first.options);
  const rejected = expect(firstOpen).rejects.toThrow("revoked");
  const secondOpen = openOpenClawAgentDatabaseAsync(second.options);
  await closeOpenClawAgentDatabasesAsync(first.options.env.OPENCLAW_STATE_DIR);
  await rejected;
  const secondDatabase = await secondOpen;
  expect(secondDatabase.db.isOpen).toBe(true);
  expect(ordinaryWrite(second.options)).toEqual({ n: 1 });
  const leases = (options: typeof first.options) =>
    openOpenClawStateDatabase({ env: options.env })
      .db.prepare("SELECT lease_id FROM agent_database_leases;")
      .all();
  expect(leases(first.options)).toEqual([]);
  expect(leases(second.options)).toHaveLength(1);
});
