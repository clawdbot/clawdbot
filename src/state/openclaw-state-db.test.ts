// OpenClaw state database tests cover state DB migrations and persistence.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { listOpenFileDescriptorsForPath } from "../infra/open-file-descriptors.test-support.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { loadTaskRegistryStateFromSqlite } from "../tasks/task-registry.store.sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
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

type PlacementConstraintProbe = {
  sessionId: string;
  state: string;
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  workerBundleHash: string | null;
  recoveryError: string | null;
  workspaceBaseManifestRef?: string;
  remoteWorkspaceDir?: string;
  lastTranscriptAckCursor?: number;
  lastLiveEventAckCursor?: number;
  turnClaimOwner?: "local" | "worker";
  turnClaimOwnerEpoch?: number;
};

function insertPlacementConstraintProbe(
  database: DatabaseSync,
  input: PlacementConstraintProbe,
): void {
  const hasClaim = input.turnClaimOwner !== undefined;
  database
    .prepare(
      `INSERT INTO worker_session_placements (
        session_id,
        agent_id,
        session_key,
        state,
        environment_id,
        active_owner_epoch,
        workspace_base_manifest_ref,
        remote_workspace_dir,
        worker_bundle_hash,
        last_transcript_ack_cursor,
        last_live_event_ack_cursor,
        recovery_error,
        turn_claim_owner,
        turn_claim_id,
        turn_claim_run_id,
        turn_claim_generation,
        turn_claim_owner_epoch,
        created_at_ms,
        updated_at_ms,
        state_changed_at_ms
      ) VALUES (?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
    )
    .run(
      input.sessionId,
      `agent:main:${input.sessionId}`,
      input.state,
      input.environmentId,
      input.activeOwnerEpoch,
      input.workspaceBaseManifestRef ?? null,
      input.remoteWorkspaceDir ?? null,
      input.workerBundleHash,
      input.lastTranscriptAckCursor ?? null,
      input.lastLiveEventAckCursor ?? null,
      input.recoveryError,
      input.turnClaimOwner ?? null,
      hasClaim ? `${input.sessionId}-claim` : null,
      hasClaim ? `${input.sessionId}-run` : null,
      hasClaim ? 0 : null,
      input.turnClaimOwnerEpoch ?? null,
    );
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

function createLegacyAuditStateDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta (
        meta_key,
        role,
        schema_version,
        created_at,
        updated_at
      ) VALUES ('primary', 'global', 1, 10, 10);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
      CREATE INDEX idx_audit_events_time
        ON audit_events(occurred_at DESC, sequence DESC);
      CREATE INDEX idx_audit_events_agent_sequence
        ON audit_events(agent_id, sequence DESC);
      CREATE INDEX idx_audit_events_session_sequence
        ON audit_events(session_key, sequence DESC);
      CREATE INDEX idx_audit_events_run_sequence
        ON audit_events(run_id, sequence DESC);
      CREATE INDEX idx_audit_events_kind_sequence
        ON audit_events(kind, sequence DESC);
      CREATE INDEX idx_audit_events_status_sequence
        ON audit_events(status, sequence DESC);
      INSERT INTO audit_events (
        sequence,
        event_id,
        source_id,
        source_sequence,
        occurred_at,
        kind,
        action,
        status,
        actor_type,
        actor_id,
        agent_id,
        run_id
      ) VALUES (
        7,
        'event-legacy',
        'run-legacy:1:100:agent.run.started',
        1,
        100,
        'agent_run',
        'agent.run.started',
        'started',
        'agent',
        'main',
        'main',
        'run-legacy'
      );
      UPDATE sqlite_sequence SET seq = 40 WHERE name = 'audit_events';
    `);
  } finally {
    db.close();
  }
  return databasePath;
}

function createCanonicalAuditStateDatabase(stateDir: string): string {
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const databasePath = database.path;
  closeOpenClawStateDatabaseForTest();
  return databasePath;
}

function rebuildAuditEventsTable(
  db: DatabaseSync,
  transformCreateSql: (sql: string) => string,
): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
    .get() as { sql?: unknown } | undefined;
  if (typeof table?.sql !== "string") {
    throw new Error("missing audit_events table SQL");
  }
  const indexes = db
    .prepare(
      `SELECT sql
         FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'audit_events'
          AND sql IS NOT NULL
        ORDER BY name`,
    )
    .all() as Array<{ sql?: unknown }>;
  const transformedCreateSql = transformCreateSql(table.sql);
  if (transformedCreateSql === table.sql) {
    throw new Error("audit_events test schema transform did not change the table");
  }
  db.exec("DROP TABLE audit_events");
  db.exec(transformedCreateSql);
  for (const index of indexes) {
    if (typeof index.sql !== "string") {
      throw new Error("missing audit_events index SQL");
    }
    db.exec(index.sql);
  }
}

function insertAuditMarker(
  db: DatabaseSync,
  eventId: string,
  sourceId: string,
  sequence = 7,
): void {
  db.prepare(
    `INSERT INTO audit_events (
       sequence, event_id, source_id, source_sequence, occurred_at, kind, action, status,
       actor_type, actor_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sequence,
    eventId,
    sourceId,
    sequence,
    100,
    "message",
    "message.inbound.processed",
    "succeeded",
    "system",
    "gateway",
  );
}

function createUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function runHotRollbackJournalRecoveryProbe(params: { moduleUrl: string; rootDir: string }): {
  integrity: string;
  journalExistsAfterRecovery: boolean;
  value: string;
} {
  const probeSource = `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";

    const moduleUrl = ${JSON.stringify(params.moduleUrl)};
    const databasePath = path.join(${JSON.stringify(params.rootDir)}, "hot-journal.sqlite");
    const readyPath = path.join(${JSON.stringify(params.rootDir)}, "writer-ready");
    const {
      closeOpenClawStateDatabaseForTest,
      openOpenClawStateDatabase,
    } = await import(moduleUrl);

    const initial = openOpenClawStateDatabase({ path: databasePath });
    initial.db.exec(\`
      CREATE TABLE hot_journal_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO hot_journal_probe (id, value) VALUES (1, 'committed');
    \`);
    closeOpenClawStateDatabaseForTest();

    const rollbackMode = new DatabaseSync(databasePath);
    rollbackMode.exec("PRAGMA journal_mode = DELETE;");
    rollbackMode.close();

    const writerSource = \`
      import fs from "node:fs";
      import { DatabaseSync } from "node:sqlite";

      const database = new DatabaseSync(process.env.OPENCLAW_HOT_JOURNAL_DATABASE_PATH);
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      database
        .prepare("UPDATE hot_journal_probe SET value = ? WHERE id = 1")
        .run("uncommitted");
      fs.writeFileSync(process.env.OPENCLAW_HOT_JOURNAL_READY_PATH, "ready");
      setInterval(() => {}, 1_000);
    \`;
    const writer = spawn(
      process.execPath,
      ["--input-type=module", "-e", writerSource],
      {
        env: {
          ...process.env,
          OPENCLAW_HOT_JOURNAL_DATABASE_PATH: databasePath,
          OPENCLAW_HOT_JOURNAL_READY_PATH: readyPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let writerStderr = "";
    writer.stderr.on("data", (chunk) => {
      writerStderr += chunk;
    });
    const writerClosed = new Promise((resolve, reject) => {
      writer.once("error", reject);
      writer.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(readyPath)) {
        if (writer.exitCode !== null || writer.signalCode !== null) {
          throw new Error(\`writer exited before creating a hot journal: \${writerStderr}\`);
        }
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for hot rollback journal writer");
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const journalPath = \`\${databasePath}-journal\`;
      if (!fs.existsSync(journalPath) || fs.statSync(journalPath).size === 0) {
        throw new Error("writer did not leave a rollback journal");
      }
      writer.kill("SIGKILL");
      const outcome = await writerClosed;
      if (outcome.signal !== "SIGKILL") {
        throw new Error(\`writer was not killed: \${JSON.stringify(outcome)} \${writerStderr}\`);
      }

      const reopened = openOpenClawStateDatabase({ path: databasePath });
      const row = reopened.db
        .prepare("SELECT value FROM hot_journal_probe WHERE id = 1")
        .get();
      const integrity = reopened.db.prepare("PRAGMA integrity_check").get();
      closeOpenClawStateDatabaseForTest();
      console.log(JSON.stringify({
        integrity: integrity?.integrity_check,
        journalExistsAfterRecovery: fs.existsSync(journalPath),
        value: row?.value,
      }));
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill("SIGKILL");
        await writerClosed;
      }
      closeOpenClawStateDatabaseForTest();
    }
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probeSource],
    { encoding: "utf8", timeout: 30_000 },
  );
  const resultLine = output.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error("hot rollback journal recovery probe produced no result");
  }
  return JSON.parse(resultLine) as {
    integrity: string;
    journalExistsAfterRecovery: boolean;
    value: string;
  };
}

function expectNoncanonicalAuditSchemaRejected(stateDir: string, databasePath: string): void {
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
    { kind: "audit-events-v2", path: databasePath },
  ]);
  expect(() => openOpenClawStateDatabase(options)).toThrow(/noncanonical audit event schema/);
  expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
    changes: [],
    warnings: [expect.stringContaining("cannot be repaired automatically")],
  });
}

function runConcurrentSchemaProbe(params: {
  mode: "fresh" | "upgrade";
  moduleUrl: string;
  rootDir: string;
}): string[] {
  const workerSource = `
    import fs from "node:fs";
    import { DatabaseSync } from "node:sqlite";

    const pageBarrierDir = process.env.OPENCLAW_SCHEMA_TEST_PAGE_BARRIER_DIR;
    if (pageBarrierDir) {
      const pageReadyPath = process.env.OPENCLAW_SCHEMA_TEST_PAGE_READY_PATH;
      const workerCount = Number(process.env.OPENCLAW_SCHEMA_TEST_WORKER_COUNT);
      const originalPrepare = DatabaseSync.prototype.prepare;
      const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
      DatabaseSync.prototype.prepare = function (sql) {
        const statement = originalPrepare.call(this, sql);
        if (sql !== "PRAGMA page_count") {
          return statement;
        }
        return new Proxy(statement, {
          get(target, property) {
            if (property === "get") {
              return (...args) => {
                const row = target.get(...args);
                if (row?.page_count !== 0) {
                  throw new Error("fresh database acquired pages before the initialization barrier");
                }
                fs.writeFileSync(pageReadyPath, "ready");
                const deadline = Date.now() + 15_000;
                while (
                  fs.readdirSync(pageBarrierDir).filter((name) => name.startsWith("page-ready-"))
                    .length < workerCount
                ) {
                  if (Date.now() >= deadline) {
                    throw new Error("timed out waiting for fresh database page-count barrier");
                  }
                  Atomics.wait(sleepBuffer, 0, 0, 2);
                }
                return row;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
    }

    const {
      closeOpenClawStateDatabaseForTest,
      openOpenClawStateDatabase,
    } = await import(process.env.OPENCLAW_SCHEMA_TEST_MODULE_URL);
    const databasePath = process.env.OPENCLAW_SCHEMA_TEST_DATABASE_PATH;
    const readyPath = process.env.OPENCLAW_SCHEMA_TEST_READY_PATH;
    const startPath = process.env.OPENCLAW_SCHEMA_TEST_START_PATH;
    fs.writeFileSync(readyPath, "ready");
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(startPath)) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for concurrent schema upgrade start");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    try {
      const database = openOpenClawStateDatabase({ path: databasePath });
      const integrity = database.db.prepare("PRAGMA integrity_check").get();
      if (integrity?.integrity_check !== "ok") {
        throw new Error("state database integrity check failed");
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  `;
  const orchestratorSource = `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";

    const moduleUrl = ${JSON.stringify(params.moduleUrl)};
    const rootDir = ${JSON.stringify(params.rootDir)};
    const mode = ${JSON.stringify(params.mode)};
    const workerSource = ${JSON.stringify(workerSource)};
    const workerCount = 8;
    const roundCount = 3;
    const databasePaths = [];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function waitForChild(child) {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
      });
    }

    for (let round = 0; round < roundCount; round += 1) {
      const databasePath = path.join(rootDir, \`concurrent-\${mode}-\${round}.sqlite\`);
      const barrierDir = path.join(rootDir, \`barrier-\${round}\`);
      fs.mkdirSync(barrierDir, { recursive: true });

      if (mode === "upgrade") {
        const {
          closeOpenClawStateDatabaseForTest,
          openOpenClawStateDatabase,
        } = await import(moduleUrl);
        openOpenClawStateDatabase({ path: databasePath });
        closeOpenClawStateDatabaseForTest();

        const legacy = new DatabaseSync(databasePath);
        legacy
          .prepare(
            \`INSERT INTO task_runs (
               task_id, runtime, requester_session_key, owner_key, scope_kind,
               child_session_key, agent_id, task, status, delivery_status,
               notify_policy, created_at, last_event_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
          )
          .run(
            \`legacy-concurrent-\${round}\`,
            "subagent",
            "agent:main:main",
            "agent:main:main",
            "session",
            \`agent:worker:subagent:concurrent-\${round}\`,
            "main",
            "Verify concurrent schema upgrade",
            "running",
            "pending",
            "done_only",
            100,
            100,
          );
        legacy.exec(\`
          DROP TABLE worker_environment_credentials;
          ALTER TABLE gateway_boot_lifecycle DROP COLUMN startup_reason;
          ALTER TABLE task_runs DROP COLUMN requester_agent_id;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_mode;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_key_id;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_signature_count;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_threshold;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_verified_at;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_bundle_hash;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_openclaw_version;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_protocol_features_json;
          ALTER TABLE worker_environments DROP COLUMN owner_epoch;
          ALTER TABLE worker_environments DROP COLUMN teardown_terminal_state;
          ALTER TABLE worker_environments DROP COLUMN ssh_host_key;
          PRAGMA user_version = 1;
          UPDATE schema_meta
             SET schema_version = 1,
                 updated_at = 1
           WHERE meta_key = 'primary';
        \`);
        legacy.close();
      }

      const startPath = path.join(barrierDir, "start");
      const workers = Array.from({ length: workerCount }, (_, index) => {
        const readyPath = path.join(barrierDir, \`ready-\${index}\`);
        const pageReadyPath = path.join(barrierDir, \`page-ready-\${index}\`);
        return spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", workerSource],
          {
            env: {
              ...process.env,
              OPENCLAW_SCHEMA_TEST_DATABASE_PATH: databasePath,
              OPENCLAW_SCHEMA_TEST_MODULE_URL: moduleUrl,
              OPENCLAW_SCHEMA_TEST_READY_PATH: readyPath,
              OPENCLAW_SCHEMA_TEST_START_PATH: startPath,
              ...(mode === "fresh"
                ? {
                    OPENCLAW_SCHEMA_TEST_PAGE_BARRIER_DIR: barrierDir,
                    OPENCLAW_SCHEMA_TEST_PAGE_READY_PATH: pageReadyPath,
                    OPENCLAW_SCHEMA_TEST_WORKER_COUNT: String(workerCount),
                  }
                : {}),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      });
      const outcomes = workers.map(waitForChild);
      try {
        const readyDeadline = Date.now() + 15_000;
        while (
          !workers.every((_worker, index) =>
            fs.existsSync(path.join(barrierDir, \`ready-\${index}\`)),
          )
        ) {
          if (workers.some((worker) => worker.exitCode !== null || worker.signalCode !== null)) {
            break;
          }
          if (Date.now() >= readyDeadline) {
            throw new Error(\`round \${round} timed out waiting for workers\`);
          }
          await sleep(2);
        }
        fs.writeFileSync(startPath, "start");
        const results = await Promise.all(outcomes);
        const failures = results.filter((result) => result.code !== 0);
        if (failures.length > 0) {
          throw new Error(\`round \${round} worker failures: \${JSON.stringify(failures)}\`);
        }
      } finally {
        for (const worker of workers) {
          if (worker.exitCode === null && worker.signalCode === null) {
            worker.kill();
          }
        }
        await Promise.allSettled(outcomes);
      }
      databasePaths.push(databasePath);
    }

    console.log(JSON.stringify(databasePaths));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", orchestratorSource],
    { encoding: "utf8", timeout: 60_000 },
  );
  const resultLine = output.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error(`concurrent schema ${params.mode} probe produced no result`);
  }
  return JSON.parse(resultLine) as string[];
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

  it("rejects a placement turn claim tuple without an owner", () => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });

    expect(() =>
      database.db
        .prepare(
          `INSERT INTO worker_session_placements (
            session_id,
            agent_id,
            session_key,
            state,
            turn_claim_id,
            turn_claim_run_id,
            turn_claim_generation,
            created_at_ms,
            updated_at_ms,
            state_changed_at_ms
          ) VALUES (?, 'main', 'agent:main:placement-claim', 'local', ?, ?, 0, 1, 1, 1)`,
        )
        .run("session-placement-claim", "claim-without-owner", "run-without-owner"),
    ).toThrow();
  });

  const validPlacementShapes = [
    {
      name: "local placement",
      sessionId: "session-local-valid",
      state: "local",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "requested placement",
      sessionId: "session-requested-valid",
      state: "requested",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "provisioning placement before environment allocation",
      sessionId: "session-provisioning-pending-valid",
      state: "provisioning",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "provisioning placement after environment allocation",
      sessionId: "session-provisioning-allocated-valid",
      state: "provisioning",
      environmentId: "environment-provisioning",
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "syncing placement",
      sessionId: "session-syncing-valid",
      state: "syncing",
      environmentId: "environment-syncing",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-syncing",
      recoveryError: null,
    },
    {
      name: "starting placement",
      sessionId: "session-starting-valid",
      state: "starting",
      environmentId: "environment-starting",
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: "manifest-starting",
      remoteWorkspaceDir: "/workspace/starting",
      workerBundleHash: "bundle-starting",
      recoveryError: null,
    },
    {
      name: "active placement",
      sessionId: "session-active-valid",
      state: "active",
      environmentId: "environment-active",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-active",
      remoteWorkspaceDir: "/workspace/active",
      workerBundleHash: "bundle-active",
      lastTranscriptAckCursor: 3,
      lastLiveEventAckCursor: 4,
      recoveryError: null,
    },
    {
      name: "draining placement",
      sessionId: "session-draining-valid",
      state: "draining",
      environmentId: "environment-draining",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-draining",
      remoteWorkspaceDir: "/workspace/draining",
      workerBundleHash: "bundle-draining",
      recoveryError: null,
    },
    {
      name: "reconciling placement",
      sessionId: "session-reconciling-valid",
      state: "reconciling",
      environmentId: "environment-reconciling",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-reconciling",
      remoteWorkspaceDir: "/workspace/reconciling",
      workerBundleHash: "bundle-reconciling",
      recoveryError: null,
    },
    {
      name: "reclaimed placement with full provenance",
      sessionId: "session-reclaimed-valid",
      state: "reclaimed",
      environmentId: "environment-reclaimed",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-reclaimed",
      remoteWorkspaceDir: "/workspace/reclaimed",
      workerBundleHash: "bundle-reclaimed",
      recoveryError: null,
    },
    {
      name: "failed placement with recovery detail",
      sessionId: "session-failed-valid",
      state: "failed",
      environmentId: "environment-failed",
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: "worker placement failed",
    },
  ] satisfies Array<PlacementConstraintProbe & { name: string }>;

  it.each(validPlacementShapes)("allows a valid $name", (input) => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });

    expect(() => insertPlacementConstraintProbe(database.db, input)).not.toThrow();
  });

  const invalidPlacementShapes = [
    {
      name: "local environment",
      sessionId: "session-local-environment",
      state: "local",
      environmentId: "environment-local",
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "syncing without environment",
      sessionId: "session-syncing-environment",
      state: "syncing",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "syncing workspace metadata",
      sessionId: "session-syncing-workspace",
      state: "syncing",
      environmentId: "environment-syncing",
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: "manifest-syncing",
      remoteWorkspaceDir: "/workspace/syncing",
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "active without owner epoch",
      sessionId: "session-active-epoch",
      state: "active",
      environmentId: "environment-active",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
      workspaceBaseManifestRef: "manifest-active",
      remoteWorkspaceDir: "/workspace/active",
    },
    {
      name: "active without worker bundle",
      sessionId: "session-active-bundle",
      state: "active",
      environmentId: "environment-active",
      activeOwnerEpoch: 7,
      workerBundleHash: null,
      recoveryError: null,
      workspaceBaseManifestRef: "manifest-active",
      remoteWorkspaceDir: "/workspace/active",
    },
    {
      name: "starting without manifest",
      sessionId: "session-starting-manifest",
      state: "starting",
      environmentId: "environment-starting",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
      remoteWorkspaceDir: "/workspace/starting",
    },
    {
      name: "starting owner epoch",
      sessionId: "session-starting-epoch",
      state: "starting",
      environmentId: "environment-starting",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-starting",
      remoteWorkspaceDir: "/workspace/starting",
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "requested worker metadata",
      sessionId: "session-requested-metadata",
      state: "requested",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "provisioning worker bundle",
      sessionId: "session-provisioning-bundle",
      state: "provisioning",
      environmentId: "environment-provisioning",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "active recovery error",
      sessionId: "session-active-recovery",
      state: "active",
      environmentId: "environment-active",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-active",
      remoteWorkspaceDir: "/workspace/active",
      workerBundleHash: "bundle-hash",
      recoveryError: "unexpected active recovery detail",
    },
    {
      name: "reclaimed placement without full provenance",
      sessionId: "session-reclaimed-provenance",
      state: "reclaimed",
      environmentId: "environment-reclaimed",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "reclaimed recovery error",
      sessionId: "session-reclaimed-recovery",
      state: "reclaimed",
      environmentId: "environment-reclaimed",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-reclaimed",
      remoteWorkspaceDir: "/workspace/reclaimed",
      workerBundleHash: "bundle-hash",
      recoveryError: "unexpected reclaimed recovery detail",
    },
    {
      name: "failed without recovery error",
      sessionId: "session-failed-recovery",
      state: "failed",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
  ] satisfies Array<PlacementConstraintProbe & { name: string }>;

  it.each(invalidPlacementShapes)("rejects a placement with $name", (input) => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });

    expect(() => insertPlacementConstraintProbe(database.db, input)).toThrow();
  });

  const invalidPlacementClaimOwners = [
    {
      name: "local claim on active placement",
      state: "active",
      activeOwnerEpoch: 7,
      turnClaimOwner: "local",
      turnClaimOwnerEpoch: undefined,
    },
    {
      name: "worker claim on reconciling placement",
      state: "reconciling",
      activeOwnerEpoch: 7,
      turnClaimOwner: "worker",
      turnClaimOwnerEpoch: 7,
    },
    {
      name: "stale worker owner epoch",
      state: "active",
      activeOwnerEpoch: 7,
      turnClaimOwner: "worker",
      turnClaimOwnerEpoch: 8,
    },
    {
      name: "worker claim on reclaimed placement",
      state: "reclaimed",
      activeOwnerEpoch: 7,
      turnClaimOwner: "worker",
      turnClaimOwnerEpoch: 7,
    },
  ] satisfies Array<{
    name: string;
    state: string;
    activeOwnerEpoch: number;
    turnClaimOwner: "local" | "worker";
    turnClaimOwnerEpoch: number | undefined;
  }>;

  it.each(invalidPlacementClaimOwners)("rejects a placement with $name", (input) => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });

    expect(() =>
      insertPlacementConstraintProbe(database.db, {
        sessionId: `session-${input.state}-${input.turnClaimOwner}`,
        state: input.state,
        environmentId: `environment-${input.state}`,
        activeOwnerEpoch: input.activeOwnerEpoch,
        workspaceBaseManifestRef: `manifest-${input.state}`,
        remoteWorkspaceDir: `/workspace/${input.state}`,
        workerBundleHash: "bundle-hash",
        recoveryError: null,
        turnClaimOwner: input.turnClaimOwner,
        ...(input.turnClaimOwnerEpoch === undefined
          ? {}
          : { turnClaimOwnerEpoch: input.turnClaimOwnerEpoch }),
      }),
    ).toThrow();
  });

  it("allows an exact worker claim while placement drains", () => {
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });

    expect(() =>
      insertPlacementConstraintProbe(database.db, {
        sessionId: "session-draining-worker",
        state: "draining",
        environmentId: "environment-draining",
        activeOwnerEpoch: 7,
        workspaceBaseManifestRef: "manifest-draining",
        remoteWorkspaceDir: "/workspace/draining",
        workerBundleHash: "bundle-hash",
        recoveryError: null,
        turnClaimOwner: "worker",
        turnClaimOwnerEpoch: 7,
      }),
    ).not.toThrow();
  });

  it("repairs a same-name shared-state uniqueness index", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const created = openOpenClawStateDatabase({ env });
    const databasePath = created.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    try {
      drifted.exec(`
        DROP INDEX idx_operator_approvals_resolution_ref;
        CREATE UNIQUE INDEX idx_operator_approvals_resolution_ref
          ON operator_approvals(approval_id);
      `);
      expect(drifted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      drifted.close();
    }

    const reopened = openOpenClawStateDatabase({ env });
    expect(
      reopened.db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_operator_approvals_resolution_ref'",
        )
        .get(),
    ).toEqual({
      sql: "CREATE UNIQUE INDEX idx_operator_approvals_resolution_ref ON operator_approvals(resolution_ref)",
    });
  });

  it("migrates the released audit ledger to message-compatible attribution exactly once", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "audit-events-v2", path: databasePath },
    ]);
    expect(() => openOpenClawStateDatabase(options)).toThrow(/legacy audit event schema/);

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: ["Migrated shared state audit event ledger → versioned message lifecycle schema"],
      warnings: [],
    });
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({ changes: [], warnings: [] });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    try {
      const columns = db.prepare("PRAGMA table_info(audit_events)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const nullability = new Map(columns.map((column) => [column.name, column.notnull === 0]));
      expect(nullability.get("schema_version")).toBe(false);
      expect(nullability.get("source_sequence")).toBe(false);
      expect(nullability.get("actor_id")).toBe(false);
      expect(nullability.get("agent_id")).toBe(true);
      expect(nullability.get("run_id")).toBe(true);
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "direction",
          "channel",
          "conversation_kind",
          "message_outcome",
          "reason_code",
          "delivery_kind",
          "failure_stage",
          "duration_ms",
          "result_count",
          "account_ref",
          "conversation_ref",
          "message_ref",
          "target_ref",
        ]),
      );
      expect(db.prepare("SELECT * FROM audit_events").get()).toMatchObject({
        sequence: 7,
        event_id: "event-legacy",
        source_id: "run-legacy:1:100:agent.run.started",
        schema_version: 1,
        source_sequence: 1,
        agent_id: "main",
        run_id: "run-legacy",
        channel: null,
        direction: null,
      });

      db.prepare(
        `INSERT INTO audit_events (
           event_id,
           source_id,
           source_sequence,
           occurred_at,
           kind,
           action,
           status,
           actor_type,
           actor_id,
           direction,
           channel,
           conversation_kind,
           account_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "event-message",
        "message-source",
        2,
        200,
        "message",
        "message.received",
        "succeeded",
        "channel_sender",
        "hmac-sha256:v1:sender",
        "inbound",
        "telegram",
        "direct",
        "hmac-sha256:v1:account",
      );
      expect(
        db
          .prepare(
            "SELECT sequence, schema_version, source_sequence, actor_id, agent_id, run_id FROM audit_events WHERE event_id = ?",
          )
          .get("event-message"),
      ).toEqual({
        sequence: 41,
        schema_version: 1,
        source_sequence: 2,
        actor_id: "hmac-sha256:v1:sender",
        agent_id: null,
        run_id: null,
      });
      const indexNames = (
        db.prepare("PRAGMA index_list(audit_events)").all() as Array<{ name: string }>
      ).map((index) => index.name);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "idx_audit_events_time",
          "idx_audit_events_agent_sequence",
          "idx_audit_events_session_sequence",
          "idx_audit_events_run_sequence",
          "idx_audit_events_kind_sequence",
          "idx_audit_events_status_sequence",
          "idx_audit_events_channel_sequence",
          "idx_audit_events_direction_sequence",
        ]),
      );
      expect(readSqliteNumberPragma(db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      expect(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      expect(() =>
        db
          .prepare(
            "INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (1, ?, ?, ?)",
          )
          .run("key-v1", new Uint8Array([1, 2, 3]), 100),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (2, ?, ?, ?)",
          )
          .run("key-v2", new Uint8Array([4, 5, 6]), 200),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("preserves an empty audit ledger's sequence high-water mark", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(
      "DELETE FROM audit_events; UPDATE sqlite_sequence SET seq = 73 WHERE name = 'audit_events';",
    );
    legacy.close();

    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);

    const migrated = new DatabaseSync(databasePath);
    try {
      migrated
        .prepare(
          `INSERT INTO audit_events (
             event_id, source_id, source_sequence, occurred_at, kind, action, status,
             actor_type, actor_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "event-after-empty-migration",
          "source-after-empty-migration",
          1,
          200,
          "message",
          "message.inbound.processed",
          "succeeded",
          "system",
          "gateway",
        );
      expect(
        migrated
          .prepare("SELECT sequence FROM audit_events WHERE event_id = ?")
          .get("event-after-empty-migration"),
      ).toEqual({ sequence: 74 });
    } finally {
      migrated.close();
    }
  });

  it("refuses an audit sequence high-water mark outside the supported cursor range", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("UPDATE sqlite_sequence SET seq = 9007199254740992 WHERE name = 'audit_events';");
    legacy.close();

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringContaining("exceeds the supported integer range")],
    });

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare(
            "SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'audit_events'",
          )
          .get(),
      ).toEqual({ seq: "9007199254740992" });
      expect(
        preserved.prepare("SELECT event_id FROM audit_events WHERE sequence = 7").get(),
      ).toEqual({ event_id: "event-legacy" });
    } finally {
      preserved.close();
    }
  });

  it("lets normal open create an audit ledger for a pre-v2 database", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE audit_events");
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({ changes: [], warnings: [] });
    const beforeOpen = new DatabaseSync(databasePath, { readOnly: true });
    expect(readSqliteNumberPragma(beforeOpen, "user_version")).toBe(1);
    beforeOpen.close();

    const opened = openOpenClawStateDatabase(options);
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
        .get(),
    ).toEqual({ name: "audit_events" });
    expect(readSqliteNumberPragma(opened.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it("refuses to rebuild a noncanonical audit table with unknown data columns", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const customized = new DatabaseSync(databasePath);
    customized.exec("ALTER TABLE audit_events ADD COLUMN operator_note TEXT;");
    customized
      .prepare("UPDATE audit_events SET operator_note = ? WHERE event_id = ?")
      .run("preserve-me", "event-legacy");
    customized.close();

    const result = repairOpenClawStateDatabaseSchema(options);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("cannot be repaired automatically")]);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT operator_note FROM audit_events WHERE event_id = ?")
          .get("event-legacy"),
      ).toEqual({ operator_note: "preserve-me" });
    } finally {
      preserved.close();
    }
  });

  it("refuses a v2 audit ledger without source identity uniqueness", () => {
    const stateDir = createTempStateDir();
    const databasePath = createCanonicalAuditStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    rebuildAuditEventsTable(malformed, (sql) =>
      sql.replace("source_id TEXT NOT NULL UNIQUE", "source_id TEXT NOT NULL"),
    );
    insertAuditMarker(malformed, "event-duplicate-source-1", "duplicate-source", 7);
    insertAuditMarker(malformed, "event-duplicate-source-2", "duplicate-source", 8);
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE source_id = ?")
          .get("duplicate-source"),
      ).toEqual({ count: 2 });
    } finally {
      preserved.close();
    }
  });

  it.each([
    ["a non-primary sequence", "sequence INTEGER"],
    ["a sequence without AUTOINCREMENT", "sequence INTEGER PRIMARY KEY"],
  ])("refuses a v2 audit ledger with %s", (_label, sequenceDeclaration) => {
    const stateDir = createTempStateDir();
    const databasePath = createCanonicalAuditStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    rebuildAuditEventsTable(malformed, (sql) =>
      sql.replace("sequence INTEGER PRIMARY KEY AUTOINCREMENT", sequenceDeclaration),
    );
    insertAuditMarker(malformed, "event-sequence-shape", "source-sequence-shape");
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT sequence FROM audit_events WHERE event_id = ?")
          .get("event-sequence-shape"),
      ).toEqual({ sequence: 7 });
    } finally {
      preserved.close();
    }
  });

  it("refuses a v2 audit ledger with an extra column without dropping its data", () => {
    const stateDir = createTempStateDir();
    const databasePath = createCanonicalAuditStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    malformed.exec("ALTER TABLE audit_events ADD COLUMN operator_note TEXT");
    insertAuditMarker(malformed, "event-v2-custom-column", "source-v2-custom-column");
    malformed
      .prepare("UPDATE audit_events SET operator_note = ? WHERE event_id = ?")
      .run("preserve-v2", "event-v2-custom-column");
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT operator_note FROM audit_events WHERE event_id = ?")
          .get("event-v2-custom-column"),
      ).toEqual({ operator_note: "preserve-v2" });
    } finally {
      preserved.close();
    }
  });

  it("refuses to recreate a missing v2 audit ledger", () => {
    const stateDir = createTempStateDir();
    const databasePath = createCanonicalAuditStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    malformed.exec("DROP TABLE audit_events");
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
          .get(),
      ).toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it("refuses a malformed audit identity key singleton table", () => {
    const stateDir = createTempStateDir();
    const databasePath = createCanonicalAuditStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    malformed.exec(`
      DROP TABLE audit_identity_keys;
      CREATE TABLE audit_identity_keys (
        id INTEGER NOT NULL PRIMARY KEY CHECK (id > 0),
        key_id TEXT NOT NULL,
        key BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    malformed
      .prepare("INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (?, ?, ?, ?)")
      .run(2, "malformed-key", new Uint8Array([1, 2, 3]), 100);
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT id, key_id FROM audit_identity_keys").get()).toEqual({
        id: 2,
        key_id: "malformed-key",
      });
    } finally {
      preserved.close();
    }
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

  it("rejects stale secondary indexes before writable initialization", () => {
    const stateDir = createTempStateDir();
    const databasePath = createCanonicalAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    createUnsafeIndexDrift(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(databasePath, { readOnly: true });
    let metadataBefore: unknown;
    try {
      expect(before.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(before.prepare("PRAGMA integrity_check").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            integrity_check: expect.stringMatching(/missing from index unsafe_index_records_value/),
          }),
        ]),
      );
      metadataBefore = before
        .prepare(
          "SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
        )
        .get();
    } finally {
      before.close();
    }

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [
        expect.stringMatching(
          /integrity_check failed.*missing from index unsafe_index_records_value/iu,
        ),
      ],
    });
    const checkpointCallback = vi.fn();
    expect(() =>
      withOpenClawStateStartupMigrationCheckpointDatabase(checkpointCallback, options),
    ).toThrow(/integrity_check failed.*missing from index unsafe_index_records_value/iu);
    expect(checkpointCallback).not.toHaveBeenCalled();

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            "SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
          )
          .get(),
      ).toEqual(metadataBefore);
      expect(after.prepare("PRAGMA integrity_check").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            integrity_check: expect.stringMatching(/missing from index unsafe_index_records_value/),
          }),
        ]),
      );
    } finally {
      after.close();
    }
  });

  it("rejects foreign-key violations before writable initialization", () => {
    const stateDir = createTempStateDir();
    const databasePath = createCanonicalAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const corrupted = new DatabaseSync(databasePath);
    try {
      corrupted.exec("PRAGMA foreign_keys = OFF;");
      corrupted.prepare("INSERT INTO task_delivery_state (task_id) VALUES (?)").run("missing-task");
      expect(corrupted.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(corrupted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(corrupted.prepare("PRAGMA foreign_key_check").get()).toEqual({
        table: "task_delivery_state",
        rowid: 1,
        parent: "task_runs",
        fkid: 0,
      });
    } finally {
      corrupted.close();
    }

    const before = new DatabaseSync(databasePath, { readOnly: true });
    let metadataBefore: unknown;
    try {
      metadataBefore = before
        .prepare(
          "SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
        )
        .get();
    } finally {
      before.close();
    }

    const failure =
      /foreign_key_check failed.*task_delivery_state row 1 references task_runs \(foreign key 0\)/iu;
    expect(() => openOpenClawStateDatabase(options)).toThrow(failure);
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringMatching(failure)],
    });
    const checkpointCallback = vi.fn();
    expect(() =>
      withOpenClawStateStartupMigrationCheckpointDatabase(checkpointCallback, options),
    ).toThrow(failure);
    expect(checkpointCallback).not.toHaveBeenCalled();

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            "SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
          )
          .get(),
      ).toEqual(metadataBefore);
      expect(after.prepare("PRAGMA foreign_key_check").get()).toEqual({
        table: "task_delivery_state",
        rowid: 1,
        parent: "task_runs",
        fkid: 0,
      });
    } finally {
      after.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal before checking integrity",
    () => {
      expect(
        runHotRollbackJournalRecoveryProbe({
          moduleUrl: new URL("./openclaw-state-db.ts", import.meta.url).href,
          rootDir: createTempStateDir(),
        }),
      ).toEqual({
        integrity: "ok",
        journalExistsAfterRecovery: false,
        value: "committed",
      });
    },
  );

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

  it("adds worker bootstrap lifecycle columns to existing state databases", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      DROP TABLE worker_environment_credentials;
      ALTER TABLE worker_environments DROP COLUMN bootstrap_bundle_hash;
      ALTER TABLE worker_environments DROP COLUMN bootstrap_openclaw_version;
      ALTER TABLE worker_environments DROP COLUMN bootstrap_protocol_features_json;
      ALTER TABLE worker_environments DROP COLUMN owner_epoch;
      ALTER TABLE worker_environments DROP COLUMN teardown_terminal_state;
      ALTER TABLE worker_environments DROP COLUMN ssh_host_key;
    `);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db.prepare("PRAGMA table_info(worker_environments)").all() as Array<{
      name?: string;
    }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "bootstrap_bundle_hash",
        "bootstrap_openclaw_version",
        "bootstrap_protocol_features_json",
        "owner_epoch",
        "teardown_terminal_state",
        "ssh_host_key",
      ]),
    );
    const credentialTable = reopened.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_environment_credentials'",
      )
      .get() as { name?: string } | undefined;
    expect(credentialTable?.name).toBe("worker_environment_credentials");
  });

  it("adds worker transcript commit tables to existing state databases", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      DROP TABLE worker_transcript_commits;
      DROP TABLE worker_transcript_commit_heads;
    `);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const tables = reopened.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN (
            'worker_transcript_commit_heads',
            'worker_transcript_commits'
          )
          ORDER BY name`,
      )
      .all() as Array<{ name?: string }>;
    expect(tables.map((table) => table.name)).toEqual([
      "worker_transcript_commit_heads",
      "worker_transcript_commits",
    ]);
  });

  it("backfills durable approval transport references in databases created by PR 1", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const databasePath = database.path;
    const approvalId = "approval/from-pr1";
    const expectedRef = buildApprovalResolutionRef({ approvalId, approvalKind: "exec" });
    database.db
      .prepare(
        `INSERT INTO operator_approvals (
          approval_id,
          resolution_ref,
          kind,
          status,
          presentation_json,
          requested_by_device_token_auth,
          reviewer_device_ids_json,
          audience_session_keys_json,
          runtime_epoch,
          created_at_ms,
          expires_at_ms,
          updated_at_ms
        ) VALUES (?, ?, 'exec', 'pending', ?, 0, '[]', '[]', 'pr1-runtime', 1, 1000, 1)`,
      )
      .run(
        approvalId,
        expectedRef,
        JSON.stringify({
          kind: "exec",
          commandText: "echo migration",
          commandPreview: null,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "deny"],
        }),
      );
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      DROP INDEX idx_operator_approvals_resolution_ref;
      ALTER TABLE operator_approvals DROP COLUMN resolution_ref;
    `);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    expect(
      reopened.db
        .prepare("SELECT resolution_ref FROM operator_approvals WHERE approval_id = ?")
        .get(approvalId),
    ).toEqual({ resolution_ref: expectedRef });
    const indexes = reopened.db.prepare("PRAGMA index_list(operator_approvals)").all() as Array<{
      name?: unknown;
      unique?: unknown;
    }>;
    expect(indexes).toContainEqual(
      expect.objectContaining({ name: "idx_operator_approvals_resolution_ref", unique: 1 }),
    );
  });

  it("serializes concurrent additive schema upgrades across processes", () => {
    const rootDir = createTempStateDir();
    const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
    const databasePaths = runConcurrentSchemaProbe({ mode: "upgrade", moduleUrl, rootDir });
    const expectedShape = createSqliteSchemaShapeFromSql(
      new URL("./openclaw-state-schema.sql", import.meta.url),
    );
    const { DatabaseSync } = requireNodeSqlite();

    expect(databasePaths).toHaveLength(3);
    for (const [round, databasePath] of databasePaths.entries()) {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(readSqliteNumberPragma(db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
        expect(
          db
            .prepare("SELECT agent_id, requester_agent_id FROM task_runs WHERE task_id = ?")
            .get(`legacy-concurrent-${round}`),
        ).toEqual({
          agent_id: "worker",
          requester_agent_id: "main",
        });
        expect(collectSqliteSchemaShape(db)).toEqual(expectedShape);
      } finally {
        db.close();
      }
    }
  }, 60_000);

  it("serializes concurrent fresh database initialization across processes", () => {
    const rootDir = createTempStateDir();
    const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
    const databasePaths = runConcurrentSchemaProbe({ mode: "fresh", moduleUrl, rootDir });
    const expectedShape = createSqliteSchemaShapeFromSql(
      new URL("./openclaw-state-schema.sql", import.meta.url),
    );
    const { DatabaseSync } = requireNodeSqlite();

    expect(databasePaths).toHaveLength(3);
    for (const databasePath of databasePaths) {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(readSqliteNumberPragma(db, "auto_vacuum")).toBe(2);
        expect(readSqliteNumberPragma(db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
        expect(collectSqliteSchemaShape(db)).toEqual(expectedShape);
      } finally {
        db.close();
      }
    }
  }, 60_000);

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

  it("normalizes obsolete task delivery statuses in existing state databases", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-state-task-delivery-status-" },
      async ({ stateDir }) => {
        const database = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: stateDir },
        });
        const insert = database.db.prepare(
          `INSERT INTO task_runs (
            task_id, runtime, requester_session_key, owner_key, scope_kind, task, status,
            delivery_status, notify_policy, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [taskId, deliveryStatus] of [
          ["obsolete", "not-requested"],
          ["canonical", "not_applicable"],
          ["pending", "pending"],
        ] as const) {
          insert.run(
            taskId,
            "cron",
            "",
            `system:cron:${taskId}`,
            "system",
            `Task ${taskId}`,
            "cancelled",
            deliveryStatus,
            "silent",
            100,
          );
        }
        closeOpenClawStateDatabaseForTest();

        const readStatuses = () =>
          openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })
            .db.prepare("SELECT task_id, delivery_status FROM task_runs ORDER BY task_id")
            .all();
        const expectedStatuses = [
          { task_id: "canonical", delivery_status: "not_applicable" },
          { task_id: "obsolete", delivery_status: "not_applicable" },
          { task_id: "pending", delivery_status: "pending" },
        ];

        expect(readStatuses()).toEqual(expectedStatuses);
        expect(
          [...loadTaskRegistryStateFromSqlite().tasks.values()].map((task) => ({
            taskId: task.taskId,
            deliveryStatus: task.deliveryStatus,
          })),
        ).toEqual([
          { taskId: "canonical", deliveryStatus: "not_applicable" },
          { taskId: "obsolete", deliveryStatus: "not_applicable" },
          { taskId: "pending", deliveryStatus: "pending" },
        ]);

        closeOpenClawStateDatabaseForTest();
        expect(readStatuses()).toEqual(expectedStatuses);
        closeOpenClawStateDatabaseForTest();
      },
    );
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

  it("adds task detail storage to an existing state database", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec("ALTER TABLE task_runs DROP COLUMN detail_json");
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db.prepare("PRAGMA table_info(task_runs)").all() as Array<{
      name?: string;
    }>;
    expect(columns.some((column) => column.name === "detail_json")).toBe(true);
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

  it("imports early cron run-log tables before dropping them", () => {
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

    expect(
      database.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_run_logs'")
        .get(),
    ).toBeUndefined();
    expect(
      database.db.prepare("SELECT source_id, ended_at FROM task_runs WHERE runtime = 'cron'").all(),
    ).toEqual([{ source_id: "legacy-job", ended_at: 12345 }]);
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

    expect(readSqliteNumberPragma(database.db, "busy_timeout")).toBe(
      OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    );
    expect(readSqliteNumberPragma(database.db, "foreign_keys")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "synchronous")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "auto_vacuum")).toBe(2);
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
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
    ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
  });

  it("refuses to open newer global schema versions", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    db.close();

    expect(() =>
      openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toThrow(
      `OpenClaw state database ${databasePath} uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}; this OpenClaw build supports ${OPENCLAW_STATE_SCHEMA_VERSION}. Upgrade OpenClaw before opening this database. Do not downgrade OpenClaw or modify the database. To run this older build, use a separate state directory or restore a compatible backup.`,
    );
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
    expect(readSqliteNumberPragma(first.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
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
