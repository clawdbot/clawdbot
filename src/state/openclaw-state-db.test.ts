// OpenClaw state database tests cover state DB migrations and persistence.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { readCronRunLogEntriesSync } from "../cron/run-log.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { listOpenFileDescriptorsForPath } from "../infra/open-file-descriptors.test-support.js";
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

type StateDbTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "diagnostic_events" | "schema_meta" | "skill_curator_state" | "skill_lifecycle" | "skill_usage"
>;

const stateDbTempDirs: string[] = [];

function createTempStateDir(): string {
  return makeTempDir(stateDbTempDirs, "openclaw-state-db-");
}

function statfsFixture(type: number): ReturnType<typeof fs.statfsSync> {
  return {
    type,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    frsize: 1024,
    ffree: 0,
  };
}

afterAll(() => {
  cleanupTempDirs(stateDbTempDirs);
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
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

  it("creates the bounded skill curator tables", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const kysely = getNodeSqliteKysely<StateDbTestDatabase>(database.db);

    executeSqliteQuerySync(
      database.db,
      kysely.insertInto("skill_usage").values({
        skill_file: "/skills/daily-brief/SKILL.md",
        skill_key: "daily-brief",
        skill_name: "Daily Brief",
        skill_source: "workspace",
        first_used_at_ms: 1,
        last_used_at_ms: 2,
        use_count: 3,
        last_agent_id: "main",
      }),
    );
    executeSqliteQuerySync(
      database.db,
      kysely.insertInto("skill_usage").values({
        skill_file: "/other-workspace/skills/daily-brief/SKILL.md",
        skill_key: "daily-brief",
        skill_name: "Daily Brief",
        skill_source: "workspace",
        first_used_at_ms: 4,
        last_used_at_ms: 5,
        use_count: 1,
        last_agent_id: "other",
      }),
    );
    executeSqliteQuerySync(
      database.db,
      kysely.insertInto("skill_lifecycle").values({
        skill_key: "daily-brief",
        skill_name: "Daily Brief",
        skill_file: "/skills/daily-brief/SKILL.md",
        state: "active",
        pinned: 0,
        state_changed_at_ms: 2,
        created_at_ms: 1,
        archived_reason: null,
      }),
    );
    executeSqliteQuerySync(
      database.db,
      kysely.insertInto("skill_lifecycle").values({
        skill_key: "daily-brief",
        skill_name: "Daily Brief",
        skill_file: "/other-workspace/skills/daily-brief/SKILL.md",
        state: "active",
        pinned: 0,
        state_changed_at_ms: 2,
        created_at_ms: 1,
        archived_reason: null,
      }),
    );
    executeSqliteQuerySync(
      database.db,
      kysely.insertInto("skill_curator_state").values({
        id: 1,
        last_attempt_at_ms: 2,
        last_success_at_ms: 2,
        last_error: null,
        last_result_json: "{}",
      }),
    );

    expect(
      executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("skill_usage")
          .select(["skill_file", "use_count"])
          .where("skill_key", "=", "daily-brief")
          .orderBy("skill_file", "asc"),
      ).rows,
    ).toEqual([
      { skill_file: "/other-workspace/skills/daily-brief/SKILL.md", use_count: 1 },
      { skill_file: "/skills/daily-brief/SKILL.md", use_count: 3 },
    ]);
    expect(
      executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("skill_lifecycle")
          .select("skill_file")
          .where("skill_key", "=", "daily-brief")
          .orderBy("skill_file", "asc"),
      ).rows,
    ).toEqual([
      { skill_file: "/other-workspace/skills/daily-brief/SKILL.md" },
      { skill_file: "/skills/daily-brief/SKILL.md" },
    ]);
  });

  it.runIf(process.platform === "linux")("closes the database when initialization fails", () => {
    const databasePath = path.join(createTempStateDir(), "openclaw.sqlite");
    fs.writeFileSync(databasePath, "not a sqlite database");

    expect(() => openOpenClawStateDatabase({ path: databasePath })).toThrow(
      "file is not a database",
    );
    expect(listOpenFileDescriptorsForPath(databasePath)).toEqual([]);
  });

  it("adds gateway boot lifecycle startup markers to existing state databases", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec("ALTER TABLE gateway_boot_lifecycle DROP COLUMN startup_reason");
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db
      .prepare("PRAGMA table_info(gateway_boot_lifecycle)")
      .all() as Array<{ name?: unknown }>;

    expect(columns.map((column) => column.name)).toContain("startup_reason");
  });

  it("migrates requester and executor attribution for existing cross-agent tasks", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec("ALTER TABLE task_runs DROP COLUMN requester_agent_id");
    legacyDb
      .prepare(
        `INSERT INTO task_runs (
          task_id,
          runtime,
          requester_session_key,
          owner_key,
          scope_kind,
          child_session_key,
          agent_id,
          task,
          status,
          delivery_status,
          notify_policy,
          created_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-cross-agent",
        "subagent",
        "agent:main:main",
        "agent:main:main",
        "session",
        "agent:worker:subagent:child",
        "main",
        "Inspect worker state",
        "running",
        "pending",
        "done_only",
        100,
        100,
      );
    legacyDb
      .prepare(
        `INSERT INTO task_runs (
          task_id,
          runtime,
          requester_session_key,
          owner_key,
          scope_kind,
          child_session_key,
          agent_id,
          task,
          status,
          delivery_status,
          notify_policy,
          created_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-global-cross-agent",
        "subagent",
        "global",
        "global",
        "session",
        "agent:worker:subagent:global-child",
        null,
        "Inspect global worker state",
        "running",
        "pending",
        "done_only",
        110,
        110,
      );
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db.prepare("PRAGMA table_info(task_runs)").all() as Array<{
      name?: string;
    }>;
    expect(columns.some((column) => column.name === "requester_agent_id")).toBe(true);
    expect(
      reopened.db
        .prepare(
          `SELECT agent_id, requester_agent_id
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get("legacy-cross-agent"),
    ).toEqual({
      agent_id: "worker",
      requester_agent_id: "main",
    });
    expect(
      reopened.db
        .prepare(
          `SELECT agent_id, requester_agent_id
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get("legacy-global-cross-agent"),
    ).toEqual({
      agent_id: null,
      requester_agent_id: null,
    });

    reopened.db
      .prepare(
        `INSERT INTO task_runs (
          task_id,
          runtime,
          requester_session_key,
          owner_key,
          scope_kind,
          child_session_key,
          agent_id,
          requester_agent_id,
          task,
          status,
          delivery_status,
          notify_policy,
          created_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "current-explicit-attribution",
        "subagent",
        "global",
        "global",
        "session",
        "agent:worker:subagent:current",
        "main",
        null,
        "Current explicit attribution",
        "running",
        "pending",
        "done_only",
        200,
        200,
      );
    closeOpenClawStateDatabaseForTest();

    const currentReopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      currentReopened.db
        .prepare(
          `SELECT agent_id, requester_agent_id
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get("current-explicit-attribution"),
    ).toEqual({
      agent_id: "main",
      requester_agent_id: null,
    });
  });

  it("adds hosted catalog snapshot trust columns to existing state databases", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_mode;
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_key_id;
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_signature_count;
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_threshold;
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_verified_at;
    `);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db
      .prepare("PRAGMA table_info(official_external_plugin_catalog_snapshots)")
      .all() as Array<{ name?: string }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "trust_mode",
        "trust_key_id",
        "trust_signature_count",
        "trust_threshold",
        "trust_verified_at",
      ]),
    );
    closeOpenClawStateDatabaseForTest();
  });

  it("rolls back the requester attribution column when its backfill fails", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      ALTER TABLE task_runs DROP COLUMN requester_agent_id;
      CREATE TRIGGER reject_task_attribution_repair
      BEFORE UPDATE ON task_runs
      BEGIN
        SELECT RAISE(ABORT, 'blocked task attribution repair');
      END;
    `);
    legacyDb
      .prepare(
        `INSERT INTO task_runs (
          task_id,
          runtime,
          requester_session_key,
          owner_key,
          scope_kind,
          child_session_key,
          agent_id,
          task,
          status,
          delivery_status,
          notify_policy,
          created_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "blocked-cross-agent",
        "subagent",
        "agent:main:main",
        "agent:main:main",
        "session",
        "agent:worker:subagent:blocked",
        "main",
        "Inspect blocked worker state",
        "running",
        "pending",
        "done_only",
        100,
        100,
      );
    legacyDb.close();

    expect(() =>
      openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toThrow(/blocked task attribution repair/);

    const interruptedDb = new DatabaseSync(databasePath);
    const interruptedColumns = interruptedDb
      .prepare("PRAGMA table_info(task_runs)")
      .all() as Array<{
      name?: string;
    }>;
    expect(interruptedColumns.some((column) => column.name === "requester_agent_id")).toBe(false);
    interruptedDb.exec("DROP TRIGGER reject_task_attribution_repair");
    interruptedDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      reopened.db
        .prepare(
          `SELECT agent_id, requester_agent_id
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get("blocked-cross-agent"),
    ).toEqual({
      agent_id: "worker",
      requester_agent_id: "main",
    });
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
    const projectedJobJson = JSON.stringify({ delivery: { threadId: 1008013 } });
    db.exec(`
      CREATE TABLE cron_jobs (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        schedule_kind TEXT NOT NULL DEFAULT 'manual',
        payload_kind TEXT NOT NULL DEFAULT 'message',
        delivery_thread_id TEXT,
        job_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id)
      );
    `);
    db.prepare(
      `INSERT INTO cron_jobs (store_key, job_id, job_json, updated_at)
         VALUES (?, ?, ?, ?)`,
    ).run(path.join(stateDir, "cron", "jobs.json"), "legacy-job", jobJson, 456);
    db.prepare(
      `INSERT INTO cron_jobs (
         store_key, job_id, name, schedule_kind, payload_kind, delivery_thread_id, job_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      path.join(stateDir, "cron", "jobs.json"),
      "already-projected-job",
      "Already projected",
      "every",
      "agentTurn",
      null,
      projectedJobJson,
      456,
    );
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
    expect(
      database.db
        .prepare(
          `SELECT delivery_thread_id, delivery_thread_id_type
             FROM cron_jobs
            WHERE job_id = ?`,
        )
        .get("already-projected-job"),
    ).toEqual({ delivery_thread_id: "1008013", delivery_thread_id_type: "number" });
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

  it("uses rollback journaling for shared state databases on NFS-backed volumes", () => {
    const stateDir = createTempStateDir();
    const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("delete");
    expect(statfs).toHaveBeenCalledWith(fs.realpathSync(path.join(stateDir, "state")));
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

  it("keys explicit relative paths by resolved database pathname", () => {
    const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import os from "node:os";
          import path from "node:path";
          import {
            closeOpenClawStateDatabaseForTest,
            openOpenClawStateDatabase,
          } from ${JSON.stringify(moduleUrl)};

          const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-db-relative-"));
          const firstDir = path.join(root, "first");
          const secondDir = path.join(root, "second");
          fs.mkdirSync(firstDir);
          fs.mkdirSync(secondDir);
          const previousCwd = process.cwd();
          try {
            process.chdir(firstDir);
            const firstPath = path.resolve("state.sqlite");
            const first = openOpenClawStateDatabase({ path: "state.sqlite" });
            first.db
              .prepare("INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES (?, ?, ?, ?)")
              .run("relative-path", "first", "{}", 1);

            process.chdir(secondDir);
            const secondPath = path.resolve("state.sqlite");
            const second = openOpenClawStateDatabase({ path: "state.sqlite" });
            second.db
              .prepare("INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES (?, ?, ?, ?)")
              .run("relative-path", "second", "{}", 2);

            console.log(JSON.stringify({
              sameHandle: first === second,
              firstPath,
              secondPath,
              firstFileExists: fs.existsSync(path.join(firstDir, "state.sqlite")),
              secondFileExists: fs.existsSync(path.join(secondDir, "state.sqlite")),
              firstRows: first.db.prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?").all("relative-path"),
              secondRows: second.db.prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?").all("relative-path"),
            }));
          } finally {
            process.chdir(previousCwd);
            closeOpenClawStateDatabaseForTest();
          }
        `,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output) as {
      firstFileExists: boolean;
      firstRows: Array<{ event_key: string }>;
      sameHandle: boolean;
      secondFileExists: boolean;
      secondRows: Array<{ event_key: string }>;
    };

    expect(result.sameHandle).toBe(false);
    expect(result.firstFileExists).toBe(true);
    expect(result.secondFileExists).toBe(true);
    expect(result.firstRows).toEqual([{ event_key: "first" }]);
    expect(result.secondRows).toEqual([{ event_key: "second" }]);
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
