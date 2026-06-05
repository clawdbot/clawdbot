// OpenClaw state database tests cover state DB migrations and persistence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCronRunLogEntriesSync } from "../cron/run-log.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
} from "./sqlite-schema-shape.test-support.js";

type StateDbTestDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events" | "schema_meta">;

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-db-"));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw state database", () => {
  it("resolves under the shared state database directory", () => {
    const stateDir = createTempStateDir();

    expect(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir })).toBe(
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
  });

  it("keeps test default state under a worker-sharded temp directory", () => {
    expect(
      resolveOpenClawStateSqlitePath({
        VITEST: "true",
        VITEST_WORKER_ID: "7",
      } as NodeJS.ProcessEnv),
    ).toBe(
      path.join(os.tmpdir(), "openclaw-test-state", `${process.pid}-7`, "state", "openclaw.sqlite"),
    );
  });

  it("creates the shared state schema from the committed SQL shape", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(collectSqliteSchemaShape(database.db)).toEqual(
      createSqliteSchemaShapeFromSql(new URL("./openclaw-state-schema.sql", import.meta.url)),
    );
    expect(database.path).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
  });

  it("opens databases with early cron tables before creating cron indexes", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    const jobJson = JSON.stringify({
      id: "legacy-job",
      name: "Legacy job",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: 123,
      updatedAtMs: 456,
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 0 },
      payload: { kind: "agentTurn", message: "hello", model: "anthropic/claude-sonnet-4-6" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "chat-1",
        accountId: "acct-1",
        bestEffort: true,
        failureDestination: { to: "https://example.invalid/hook" },
      },
      failureAlert: { mode: "announce", channel: "discord", to: "ops", after: 2 },
    });
    db.exec(`
      CREATE TABLE cron_jobs (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        job_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id)
      );
    `);
    db.prepare(
      `INSERT INTO cron_jobs (store_key, job_id, job_json, updated_at)
         VALUES (?, ?, ?, ?)`,
    ).run(path.join(stateDir, "cron", "jobs.json"), "legacy-job", jobJson, 456);
    db.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(() =>
      database.db.prepare("SELECT enabled, session_key FROM cron_jobs LIMIT 1").all(),
    ).not.toThrow();
    expect(
      database.db
        .prepare(
          `SELECT name, enabled, delete_after_run, schedule_kind, every_ms, payload_kind, payload_message,
                  payload_model, agent_id, session_key, session_target, wake_mode, delivery_mode, delivery_channel,
                  delivery_to, delivery_account_id, delivery_best_effort, failure_delivery_mode,
                  failure_delivery_channel, failure_delivery_to, failure_delivery_account_id,
                  failure_alert_mode, failure_alert_channel, failure_alert_to,
                  failure_alert_after
             FROM cron_jobs
            WHERE job_id = ?`,
        )
        .get("legacy-job"),
    ).toEqual({
      enabled: 1,
      delete_after_run: 1,
      every_ms: 3_600_000,
      agent_id: "agent-a",
      name: "Legacy job",
      payload_kind: "agentTurn",
      payload_message: "hello",
      payload_model: "anthropic/claude-sonnet-4-6",
      schedule_kind: "every",
      session_key: "agent:agent-a:main",
      session_target: "isolated",
      wake_mode: "now",
      delivery_account_id: "acct-1",
      delivery_best_effort: 1,
      delivery_channel: "telegram",
      delivery_mode: "announce",
      delivery_to: "chat-1",
      failure_alert_after: 2,
      failure_alert_channel: "discord",
      failure_alert_mode: "announce",
      failure_alert_to: "ops",
      failure_delivery_account_id: null,
      failure_delivery_channel: null,
      failure_delivery_mode: null,
      failure_delivery_to: "https://example.invalid/hook",
    });
  });

  it("opens databases with early cron run-log tables before creating cron indexes", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE cron_run_logs (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id, seq)
      );
    `);
    db.prepare("INSERT INTO cron_run_logs (store_key, job_id, seq, ts) VALUES (?, ?, ?, ?)").run(
      path.join(stateDir, "cron", "jobs.json"),
      "legacy-job",
      1,
      12345,
    );
    db.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(() =>
      database.db.prepare("SELECT status, entry_json FROM cron_run_logs LIMIT 1").all(),
    ).not.toThrow();

    const previousStateDir = process.env["OPENCLAW_STATE_DIR"];
    process.env["OPENCLAW_STATE_DIR"] = stateDir;
    try {
      expect(
        readCronRunLogEntriesSync({
          storePath: path.join(stateDir, "cron", "jobs.json"),
          jobId: "legacy-job",
        }),
      ).toMatchObject([{ action: "finished", jobId: "legacy-job", ts: 12345 }]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env["OPENCLAW_STATE_DIR"];
      } else {
        process.env["OPENCLAW_STATE_DIR"] = previousStateDir;
      }
    }
  });

  it("opens databases with early queue and commitment tables before creating newer indexes", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE sandbox_registry_entries (
        registry_kind TEXT NOT NULL,
        container_name TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (registry_kind, container_name)
      );
      CREATE TABLE delivery_queue_entries (
        queue_name TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failed_at INTEGER,
        PRIMARY KEY (queue_name, id)
      );
      CREATE TABLE commitments (
        id TEXT NOT NULL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        due_earliest_ms INTEGER NOT NULL,
        due_latest_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "outbound",
      "delivery-1",
      "pending",
      JSON.stringify({
        id: "delivery-1",
        enqueuedAt: 10,
        retryCount: 3,
        lastAttemptAt: 20,
        lastError: "no listener",
        kind: "message",
        sessionKey: "agent:main:main",
        route: { channel: "telegram", to: "chat-1", accountId: "acct-1" },
      }),
      10,
      10,
      null,
    );
    db.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(() =>
      database.db.prepare("SELECT session_key FROM sandbox_registry_entries LIMIT 1").all(),
    ).not.toThrow();
    expect(() =>
      database.db.prepare("SELECT session_key FROM delivery_queue_entries LIMIT 1").all(),
    ).not.toThrow();
    expect(
      database.db
        .prepare(
          `SELECT retry_count, last_attempt_at, last_error, entry_kind, session_key,
                  channel, target, account_id
             FROM delivery_queue_entries
            WHERE id = ?`,
        )
        .get("delivery-1"),
    ).toEqual({
      account_id: "acct-1",
      channel: "telegram",
      entry_kind: "message",
      last_attempt_at: 20,
      last_error: "no listener",
      retry_count: 3,
      session_key: "agent:main:main",
      target: "chat-1",
    });
    expect(() =>
      database.db.prepare("SELECT dedupe_key FROM commitments LIMIT 1").all(),
    ).not.toThrow();
  });

  it("configures durable SQLite connection pragmas", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(readSqliteNumberPragma(database.db, "busy_timeout")).toBe(30_000);
    expect(readSqliteNumberPragma(database.db, "foreign_keys")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "synchronous")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "wal_autocheckpoint")).toBe(1000);
    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("records durable schema metadata", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);

    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        stateDb.selectFrom("schema_meta").select(["role", "schema_version"]),
      ),
    ).toEqual({ role: "global", schema_version: 1 });
  });

  it("refuses to open newer global schema versions", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA user_version = 2;");
    db.close();

    expect(() =>
      openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toThrow(/newer schema version 2/);
  });

  it("does not chmod shared parent directories for explicit database paths", () => {
    const databasePath = path.join(
      os.tmpdir(),
      `openclaw-explicit-state-${process.pid}-${Date.now()}.sqlite`,
    );

    expect(() => openOpenClawStateDatabase({ path: databasePath })).not.toThrow();
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it("keeps cached handles open when another state path is opened", () => {
    const firstPath = path.join(
      createTempStateDir(),
      "state",
      `first-${process.pid}-${Date.now()}.sqlite`,
    );
    const secondPath = path.join(
      createTempStateDir(),
      "state",
      `second-${process.pid}-${Date.now()}.sqlite`,
    );

    const first = openOpenClawStateDatabase({ path: firstPath });
    const second = openOpenClawStateDatabase({ path: secondPath });

    expect(first.db.isOpen).toBe(true);
    expect(second.db.isOpen).toBe(true);
    expect(openOpenClawStateDatabase({ path: firstPath })).toBe(first);
    expect(readSqliteNumberPragma(first.db, "user_version")).toBe(1);
  });

  it("uses savepoints for nested write transaction rollback", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    runOpenClawStateWriteTransaction((database) => {
      const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        stateDb.insertInto("diagnostic_events").values({
          scope: "transaction-test",
          event_key: "outer",
          payload_json: "{}",
          created_at: 1,
        }),
      );
      expect(() =>
        runOpenClawStateWriteTransaction((inner) => {
          const innerDb = getNodeSqliteKysely<StateDbTestDatabase>(inner.db);
          executeSqliteQuerySync(
            inner.db,
            innerDb.insertInto("diagnostic_events").values({
              scope: "transaction-test",
              event_key: "inner",
              payload_json: "{}",
              created_at: 2,
            }),
          );
          throw new Error("rollback nested");
        }, options),
      ).toThrow("rollback nested");
    }, options);

    const database = openOpenClawStateDatabase(options);
    const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
    expect(
      executeSqliteQuerySync(
        database.db,
        stateDb
          .selectFrom("diagnostic_events")
          .select("event_key")
          .where("scope", "=", "transaction-test")
          .orderBy("event_key"),
      ).rows.map((row) => row.event_key),
    ).toEqual(["outer"]);
  });

  it("rejects Promise-returning write transactions", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    expect(() =>
      runOpenClawStateWriteTransaction(async () => {
        return "not sync";
      }, options),
    ).toThrow("must be synchronous");

    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          stateDb.insertInto("diagnostic_events").values({
            scope: "transaction-test",
            event_key: "after",
            payload_json: "{}",
            created_at: 3,
          }),
        );
      }, options),
    ).not.toThrow();
  });
});
