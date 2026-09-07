import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { ensureNodeWorkerPreparedWorkspaceSchema } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "./openclaw-state-schema-v17.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const migrationPaths = ["runtime open", "doctor repair"] as const;
const preparationKey = "a".repeat(64);
const migrationCases = [15, 16].flatMap((version) =>
  migrationPaths.map((via) => ({ version, via })),
);
const retainedTables = [
  "worker_environment_credentials",
  "worker_environment_ssh_fallback_ports",
  "worker_inference_turns",
  "worker_session_placements",
  "worker_transcript_commit_heads",
] as const;

afterEach(() => closeOpenClawStateDatabaseForTest());

function readObligations(db: DatabaseSync) {
  return Object.fromEntries(
    retainedTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
  );
}

function readSnapshot(db: DatabaseSync) {
  return {
    version: db.prepare("PRAGMA user_version").get(),
    metadata: db.prepare("SELECT * FROM schema_meta").all(),
    schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
    environments: db.prepare("SELECT rowid, * FROM worker_environments").all(),
    workshopProposals: db.prepare("SELECT * FROM skill_workshop_proposals").all(),
    workshopReviews: db.prepare("SELECT * FROM skill_workshop_collection_reviews").all(),
    obligations: readObligations(db),
  };
}

function createLegacyWorkers(version = 16) {
  const options = {
    env: { OPENCLAW_STATE_DIR: tempDirs.make(`openclaw-prepared-v${version}-`) },
  };
  const databasePath = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();
  const legacy = openNodeSqliteDatabase(databasePath);
  try {
    removePreparedWorkerOwnershipColumns(legacy);
    legacy.exec(`INSERT INTO skill_workshop_proposals (
      proposal_id, record_json, owner_agent_id, kind, status, created_at, updated_at, draft_hash
    ) VALUES ('retained-proposal', '{}', 'main', 'create', 'pending', '2026-08-01', '2026-08-01', 'hash');`);
    if (version === 15) {
      legacy.exec(`
        ALTER TABLE skill_workshop_proposals ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
        ALTER TABLE skill_workshop_proposals ADD COLUMN claim_released_time INTEGER;
        UPDATE skill_workshop_proposals SET workspace_dir = '/workspace';
        DROP TABLE skill_workshop_collection_reviews;
        CREATE TABLE skill_workshop_collection_reviews (
          review_id TEXT NOT NULL PRIMARY KEY,
          workspace_dir TEXT NOT NULL,
          backup_id TEXT NOT NULL,
          create_time INTEGER NOT NULL,
          kept_names_json TEXT NOT NULL,
          written_names_json TEXT NOT NULL,
          dropped_json TEXT NOT NULL
        ) STRICT;
        INSERT INTO skill_workshop_collection_reviews
          VALUES ('retained-review', '/workspace', 'backup', 1, '[]', '[]', '[]');
      `);
    } else {
      legacy.exec(`INSERT INTO skill_workshop_collection_reviews
        VALUES ('retained-review', 'main', 'backup', 1, '[]', '[]', '[]');`);
    }
    legacy.exec(`
      ALTER TABLE worker_environments ADD COLUMN future_note TEXT;
      PRAGMA user_version = ${version};
      UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
      INSERT INTO worker_environments (
        environment_id, provider_id, profile_id, profile_snapshot_json,
        provision_operation_id, lease_id, state, owner_epoch,
        created_at_ms, updated_at_ms, state_changed_at_ms,
        destroy_requested_at_ms, last_error, future_note
      ) VALUES ('environment', 'fixture', 'profile', '{"cleanup":"retained"}',
        'fixed-operation', 'unresolved-lease', 'destroying', 2,
        10, 20, 20, 20, 'provider cleanup remains uncertain', 'preserve future data');
      INSERT INTO worker_environment_credentials (
        environment_id, credential_hash, bundle_hash, session_id,
        rpc_set_version, owner_epoch, expires_at_ms
      ) VALUES ('environment', 'fixture-hash', 'fixture-bundle', 'session', 1, 2, 1000);
      INSERT INTO worker_environment_ssh_fallback_ports VALUES ('environment', 0, 2222);
      INSERT INTO worker_session_placements (
        session_id, agent_id, session_key, execution_mode, state, environment_id,
        created_at_ms, updated_at_ms, state_changed_at_ms
      ) VALUES ('session', 'main', 'agent:main:fixture', 'remote-exec', 'provisioning',
        'environment', 10, 20, 20);
      INSERT INTO worker_inference_turns (
        session_id, run_epoch, run_id, turn_id, environment_id, request_hash,
        state, created_at_ms, updated_at_ms
      ) VALUES ('session', 2, 'run', 'turn', 'environment', 'request', 'pending', 10, 20);
      INSERT INTO worker_transcript_commit_heads VALUES ('session', 2, 'environment', 1, 20);
    `);
    return { options, databasePath, before: readSnapshot(legacy) };
  } finally {
    legacy.close();
  }
}

describe("prepared worker schema migration", () => {
  it.each(migrationCases)(
    "preserves v$version workers and unresolved cleanup through $via",
    ({ version, via }) => {
      const { options, databasePath, before } = createLegacyWorkers(version);
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "prepared-worker-ownership-v17",
        path: databasePath,
      });
      if (via === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [
            ...(version === 15
              ? ["Moved Skill Workshop ownership to per-agent directories (v16)"]
              : []),
            "Recorded prepared worker ownership and one-use lifecycle (v17)",
          ],
          warnings: [],
        });
      }
      const { db } = openOpenClawStateDatabase(options);
      expect(db.prepare("SELECT rowid, * FROM worker_environments").all()).toEqual(
        before.environments.map((row) => ({
          ...row,
          last_activated_at_ms: null,
          preparation_key: null,
          preparation_demand_at_ms: null,
          preparation_expires_at_ms: null,
          preparation_consumed_at_ms: null,
        })),
      );
      expect(readObligations(db)).toEqual(before.obligations);
      expect(db.prepare("SELECT * FROM skill_workshop_proposals").all()).toEqual(
        before.workshopProposals.map(
          ({ workspace_dir: _workspace, claim_released_time: _released, ...proposal }) => proposal,
        ),
      );
      expect(db.prepare("SELECT * FROM skill_workshop_collection_reviews").all()).toEqual([
        {
          review_id: "retained-review",
          owner_agent_id: "main",
          backup_id: "backup",
          create_time: 1,
          kept_names_json: "[]",
          written_names_json: "[]",
          dropped_json: "[]",
        },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'node_worker_prepared_workspaces'")
          .get(),
      ).toBeUndefined();
      const after = readSnapshot(db);
      closeOpenClawStateDatabaseForTest();
      expect(readSnapshot(openOpenClawStateDatabase(options).db)).toEqual(after);
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
    },
  );

  it.each(migrationCases)(
    "rolls back all v$version migrations and markers after failed $via",
    ({ version, via }) => {
      const { options, databasePath } = createLegacyWorkers(version);
      const legacy = openNodeSqliteDatabase(databasePath);
      legacy.exec(`CREATE TRIGGER fixture_reject_upgrade BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'prepared migration rollback'); END;`);
      const before = readSnapshot(legacy);
      legacy.close();
      if (via === "runtime open") {
        expect(() => openOpenClawStateDatabase(options)).toThrow(/prepared migration rollback/);
      } else {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [],
          warnings: [expect.stringContaining("prepared migration rollback")],
        });
      }
      const preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(readSnapshot(preserved)).toEqual(before);
      } finally {
        preserved.close();
      }
    },
  );

  it.each(migrationCases)(
    "refuses incomplete v$version ownership before $via",
    ({ version, via }) => {
      const { options, databasePath } = createLegacyWorkers(version);
      const legacy = openNodeSqliteDatabase(databasePath);
      legacy.exec("DROP TABLE session_groups;");
      const before = readSnapshot(legacy);
      legacy.close();
      if (via === "runtime open") {
        expect(() => openOpenClawStateDatabase(options)).toThrow(/missing table session_groups/);
      } else {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([
          expect.stringContaining("missing table session_groups"),
        ]);
      }
      const preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(readSnapshot(preserved)).toEqual(before);
      } finally {
        preserved.close();
      }
    },
  );

  it("enforces complete preparation facts and retains consumed bindings on canonical reopen", () => {
    const { options } = createLegacyWorkers();
    const { db } = openOpenClawStateDatabase(options);
    const setPreparation = db.prepare(`UPDATE worker_environments SET preparation_key = ?,
      preparation_demand_at_ms = ?, preparation_expires_at_ms = ?, preparation_consumed_at_ms = ?`);
    for (const tuple of [
      [preparationKey, null, 100, null],
      [null, 10, 100, null],
      [preparationKey.toUpperCase(), 10, 100, null],
      [preparationKey, -1, 100, null],
      [preparationKey, 10, 10, null],
      [preparationKey, 10, Number.MAX_SAFE_INTEGER + 1, null],
      [preparationKey, 10, 100, 9],
      [preparationKey, 10, 100, 100],
    ] as const) {
      expect(() => setPreparation.run(...tuple)).toThrow(/CHECK constraint failed/);
    }
    setPreparation.run(preparationKey, 10, 100, 20);
    ensureNodeWorkerPreparedWorkspaceSchema(db);
    db.prepare(`INSERT INTO node_worker_prepared_workspaces (
      preparation_key, cache_key, gateway_namespace, workspace_dir, home_dir, source_manifest_ref,
      state, environment_id, session_id, session_key, owner_epoch, created_at_ms, bound_at_ms
    ) VALUES (?, ?, 'gateway', '/prepared/workspace', '/prepared/home', ?,
      'bound', 'environment', 'session', 'agent:main:fixture', 2, 10, 20)`).run(
      preparationKey,
      "c".repeat(64),
      `sha256:${preparationKey}`,
    );
    const setCacheKey = db.prepare("UPDATE node_worker_prepared_workspaces SET cache_key = ?");
    for (const invalid of [null, "", "c".repeat(63), "C".repeat(64)]) {
      expect(() => setCacheKey.run(invalid)).toThrow(/constraint failed/);
    }
    expect(() => db.exec("UPDATE node_worker_prepared_workspaces SET state = 'available'")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => db.exec("UPDATE node_worker_prepared_workspaces SET session_key = NULL")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      db.exec("UPDATE node_worker_prepared_workspaces SET environment_id = NULL"),
    ).toThrow(/NOT NULL constraint failed/);
    db.exec("UPDATE node_worker_prepared_workspaces SET state = 'retired', retired_at_ms = 30");
    const binding = db.prepare("SELECT * FROM node_worker_prepared_workspaces").get();
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(reopened.prepare("SELECT * FROM node_worker_prepared_workspaces").get()).toEqual(
      binding,
    );
    expect(
      reopened.prepare("SELECT preparation_consumed_at_ms FROM worker_environments").get(),
    ).toEqual({ preparation_consumed_at_ms: 20 });
  });
});
