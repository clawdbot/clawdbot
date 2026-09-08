import { spawn, type ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { VERSION } from "../version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  reconcileOpenClawStateSchemaPublication,
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const migrationPaths = ["runtime open", "doctor repair"] as const;
const pluginTarget = "plugin-binding:fixture:shared";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function readBindings(database: DatabaseSync) {
  return database.prepare("SELECT * FROM current_conversation_bindings ORDER BY binding_key").all();
}

function readMigrationSnapshot(database: DatabaseSync) {
  return {
    version: database.prepare("PRAGMA user_version").get(),
    metadata: database.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").get(),
    schema: database
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'current_conversation_bindings' ORDER BY type, name",
      )
      .all(),
    rows: readBindings(database),
  };
}

function createVersion14Bindings() {
  const stateDir = tempDirs.make("openclaw-binding-targets-v14-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();

  const legacy = openNodeSqliteDatabase(databasePath);
  try {
    const columns = new Set(
      legacy
        .prepare("PRAGMA table_info(current_conversation_bindings)")
        .all()
        .map((row) => row.name),
    );
    for (const [column, declaration] of [
      ["target_agent_id", "TEXT NOT NULL DEFAULT 'main'"],
      ["target_session_id", "TEXT"],
    ]) {
      if (!columns.has(column)) {
        legacy.exec(
          `ALTER TABLE current_conversation_bindings ADD COLUMN ${column} ${declaration};`,
        );
      }
    }
    // A compatible future column must survive; copying only canonical columns loses its data.
    legacy.exec(`
      ALTER TABLE current_conversation_bindings ADD COLUMN future_note TEXT;
      DROP INDEX idx_current_conversation_bindings_target;
      CREATE INDEX idx_current_conversation_bindings_target
        ON current_conversation_bindings(target_agent_id, target_session_key, updated_at DESC, binding_key);
      PRAGMA user_version = 14;
      UPDATE schema_meta SET schema_version = 14, app_version = NULL WHERE meta_key = 'primary';
    `);
    const insert = legacy.prepare(`
      INSERT INTO current_conversation_bindings (
        binding_key, binding_id, target_agent_id, target_session_id, target_session_key,
        channel, account_id, conversation_kind, parent_conversation_id, conversation_id,
        target_kind, status, bound_at, expires_at, metadata_json, record_json, updated_at, future_note
      ) VALUES (?, ?, ?, NULL, ?, 'fixture-channel', ?, 'current', ?, ?,
                'session', 'active', 10, ?, ?, ?, 20, ?)
    `);
    for (const [conversationId, accountId, target, agent, expiresAt] of [
      ["first", "work", pluginTarget, "main", 1],
      ["second", "work", pluginTarget, "main", null],
      ["third", "personal", "agent:worker:session", "worker", 9_000_000_000_000],
    ] as const) {
      const bindingId = `generic:fixture-channel␟${accountId}␟parent␟${conversationId}`;
      const metadata = { owner: "fixture", lastActivityAt: 15 };
      const record = {
        bindingId,
        targetSessionKey: target,
        targetKind: "session",
        conversation: {
          channel: "fixture-channel",
          accountId,
          parentConversationId: "parent",
          conversationId,
        },
        status: "active",
        boundAt: 10,
        ...(expiresAt === null ? {} : { expiresAt }),
        metadata,
      };
      insert.run(
        bindingId.slice("generic:".length),
        bindingId,
        agent,
        target,
        accountId,
        "parent",
        conversationId,
        expiresAt,
        JSON.stringify(metadata, null, 2),
        JSON.stringify(record, null, 2),
        `keep:${conversationId}`,
      );
    }
    return { options, databasePath, before: readMigrationSnapshot(legacy) };
  } finally {
    legacy.close();
  }
}

async function holdGatewayLifecycle(databasePath: string): Promise<{
  child: ChildProcess;
  release: () => Promise<void>;
}> {
  const coordinatorUrl = new URL("../infra/state-database-coordinator.ts", import.meta.url).href;
  const source = `
    import { acquireGatewayLifecycleCoordinator } from ${JSON.stringify(coordinatorUrl)};
    const coordinator = acquireGatewayLifecycleCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
    process.stdout.write("ready\\n");
    process.stdin.resume();
    process.stdin.once("end", () => coordinator.release());
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Gateway lifecycle holder timed out")),
        5_000,
      );
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (!stdout.includes("ready\n")) {
          return;
        }
        clearTimeout(timeout);
        resolve();
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Gateway lifecycle holder exited early: code=${code} signal=${signal}`));
      });
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return {
    child,
    release: async () => {
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });
      }
    },
  };
}

describe("conversation binding target migration", () => {
  it("admits deferred content without schema mutation while another Gateway owns the state", async () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-deferred-reader-") } };
    const initial = openOpenClawStateDatabase(options);
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
    initial.db
      .prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
      VALUES ('state.schema.contentVersion', ?, ?)`)
      .run(String(OPENCLAW_STATE_SCHEMA_VERSION), Date.now());
    initial.db.exec(`PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);
    initial.db
      .prepare(`UPDATE update_runs SET status = 'succeeded', phase = 'finished',
      finished_at_ms = ? WHERE run_id = ?`)
      .run(Date.now() - 60_000, run.runId);
    closeOpenClawStateDatabaseForTest();
    const holder = await holdGatewayLifecycle(initial.path);
    try {
      expect(repairOpenClawStateDatabaseSchemaIfNeeded(options)).toEqual({
        changes: [],
        warnings: [],
      });
      const reader = openOpenClawStateDatabase(options);
      expect(reader.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
      expect(reader.db.prepare("SELECT total_changes() AS writes").get()).toEqual({ writes: 0 });
      reader.db
        .prepare("UPDATE update_runs SET finished_at_ms = ? WHERE run_id = ?")
        .run(Date.now() - 5 * 60_000, run.runId);
      expect(() => reconcileOpenClawStateSchemaPublication(options)).not.toThrow();
      expect(openOpenClawStateDatabase(options).db).toBe(reader.db);
      expect(reader.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
      closeOpenClawStateDatabaseForTest();
      const agedReader = openOpenClawStateDatabase(options);
      expect(agedReader.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
      expect(agedReader.db.prepare("SELECT total_changes() AS writes").get()).toEqual({
        writes: 0,
      });
    } finally {
      await holder.release();
    }
    expect(openOpenClawStateDatabase(options).db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });

  it("refuses runtime and doctor schema mutation while another Gateway owns the state", async () => {
    const { options, databasePath } = createVersion14Bindings();
    const holder = await holdGatewayLifecycle(databasePath);
    try {
      for (const migrate of [
        () => openOpenClawStateDatabase(options),
        () => repairOpenClawStateDatabaseSchema(options),
      ]) {
        expect(migrate).toThrow(
          expect.objectContaining({
            name: "StateSchemaMutationConflictError",
            message: expect.stringContaining("another Gateway owns that state directory"),
          }),
        );
      }
      const preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(preserved.prepare("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      } finally {
        preserved.close();
      }
    } finally {
      await holder.release();
    }
  });

  it.each(migrationPaths)(
    "preserves bindings and additive data through %s and cold reopen under a Gateway",
    async (migrationPath) => {
      const { options, databasePath, before } = createVersion14Bindings();
      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      const migrated = openOpenClawStateDatabase(options);
      const columns = migrated.db
        .prepare("PRAGMA table_info(current_conversation_bindings)")
        .all()
        .map((row) => row.name);
      expect(columns).not.toContain("target_agent_id");
      expect(columns).not.toContain("target_session_id");
      expect(readBindings(migrated.db)).toEqual(
        before.rows.map(({ target_agent_id: _agent, target_session_id: _session, ...row }) => row),
      );
      expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        migrated.db
          .prepare("SELECT schema_version, app_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION, app_version: VERSION });
      expect(
        migrated.db
          .prepare(
            "SELECT name, \"unique\" FROM pragma_index_list('current_conversation_bindings') WHERE name = 'idx_current_conversation_bindings_target'",
          )
          .get(),
      ).toEqual({ name: "idx_current_conversation_bindings_target", unique: 0 });
      const query =
        "SELECT binding_id FROM current_conversation_bindings WHERE target_session_key = ?";
      expect(migrated.db.prepare(query).all(pluginTarget)).toHaveLength(2);
      expect(
        migrated.db
          .prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all(pluginTarget)
          .map((row) => row.detail),
      ).toEqual([
        expect.stringMatching(
          /SEARCH current_conversation_bindings USING INDEX idx_current_conversation_bindings_target \(target_session_key=\?\)/,
        ),
      ]);
      expect(migrated.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const after = readMigrationSnapshot(migrated.db);
      closeOpenClawStateDatabaseForTest();
      const holder = await holdGatewayLifecycle(databasePath);
      try {
        expect(readMigrationSnapshot(openOpenClawStateDatabase(options).db)).toEqual(after);
      } finally {
        closeOpenClawStateDatabaseForTest();
        await holder.release();
      }
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      const repaired = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(readBindings(repaired)).toEqual(after.rows);
        expect(readMigrationSnapshot(repaired).schema).toEqual(after.schema);
      } finally {
        repaired.close();
      }
    },
  );

  it.each(
    migrationPaths.flatMap((migrationPath) =>
      (["dependent trigger", "owner mismatch"] as const).map((failure) => ({
        migrationPath,
        failure,
      })),
    ),
  )(
    "preserves the complete old database after $failure through $migrationPath",
    ({ migrationPath, failure }) => {
      const { options, databasePath } = createVersion14Bindings();
      const legacy = openNodeSqliteDatabase(databasePath);
      let before: ReturnType<typeof readMigrationSnapshot>;
      try {
        if (failure === "dependent trigger") {
          // The second DROP must fail after the first column and target index were removed.
          legacy.exec(`CREATE TRIGGER fixture_binding_session_guard
          AFTER UPDATE ON current_conversation_bindings
          BEGIN SELECT OLD.target_session_id; END;`);
        } else {
          legacy.exec("UPDATE schema_meta SET role = 'agent' WHERE meta_key = 'primary';");
        }
        before = readMigrationSnapshot(legacy);
      } finally {
        legacy.close();
      }
      const reason = failure === "dependent trigger" ? /target_session_id/ : /expected global/;
      if (migrationPath === "runtime open") {
        expect(() => openOpenClawStateDatabase(options)).toThrow(reason);
      } else {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [],
          warnings: [expect.stringMatching(reason)],
        });
      }
      const preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(readMigrationSnapshot(preserved)).toEqual(before);
      } finally {
        preserved.close();
      }
    },
  );
});
