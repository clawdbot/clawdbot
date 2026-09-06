import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  migrateOpenClawAgentDatabaseForMaintenance,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs: string[] = [];

function createCurrentAgentDatabase(): { databasePath: string; env: NodeJS.ProcessEnv } {
  const stateDir = makeTempDir(tempDirs, "agent-db-retired-lease-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { databasePath, env };
}

function installRetiredLeaseSchema(databasePath: string): void {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec(`
      CREATE TABLE state_leases (
        scope TEXT NOT NULL,
        lease_key TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at INTEGER,
        heartbeat_at INTEGER,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, lease_key)
      ) STRICT;
      CREATE INDEX idx_agent_state_leases_expiry
        ON state_leases(expires_at, scope, lease_key)
        WHERE expires_at IS NOT NULL;
      CREATE INDEX idx_agent_state_leases_owner
        ON state_leases(owner, updated_at DESC);
      INSERT INTO state_leases (
        scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
      ) VALUES ('retired', 'orphan', 'nobody', NULL, NULL, NULL, 1, 1);
      ANALYZE state_leases;
    `);
  } finally {
    database.close();
  }
}

function readPrimarySchemaMetadata(databasePath: string): unknown {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").get();
  } finally {
    database.close();
  }
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("retired agent state lease repair", () => {
  it("repairs a mis-stamped v17 database while preserving auth and ownership", async () => {
    const { databasePath, env } = createCurrentAgentDatabase();
    installRetiredLeaseSchema(databasePath);
    const beforeMetadata = readPrimarySchemaMetadata(databasePath);
    const database = openNodeSqliteDatabase(databasePath);
    try {
      database
        .prepare(
          "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
        )
        .run("last-good", '{"profile":"primary"}', 10);
      database
        .prepare(
          "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
        )
        .run("primary", '{"profiles":{"primary":{"provider":"openai"}}}', 10);
    } finally {
      database.close();
    }

    expect((await migrateLegacyMediaPersistence({ env })).warnings).toEqual([]);
    expect((await migrateLegacyMediaPersistence({ env })).warnings).toEqual([]);

    const repaired = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(repaired.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        repaired.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual(beforeMetadata);
      expect(
        repaired
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key = 'last-good'")
          .get(),
      ).toEqual({ state_json: '{"profile":"primary"}' });
      expect(
        repaired
          .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
          .get(),
      ).toEqual({ store_json: '{"profiles":{"primary":{"provider":"openai"}}}' });
      expect(
        repaired
          .prepare(
            `SELECT type, name FROM sqlite_schema
             WHERE name IN (
               'state_leases',
               'idx_agent_state_leases_expiry',
               'idx_agent_state_leases_owner'
             )`,
          )
          .all(),
      ).toEqual([]);
      expect(
        repaired.prepare("SELECT tbl, idx FROM sqlite_stat1 WHERE tbl = 'state_leases'").all(),
      ).toEqual([]);
      expect(repaired.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      repaired.close();
    }
  });

  it("leaves a clean v17 database unchanged", async () => {
    const { databasePath, env } = createCurrentAgentDatabase();
    const beforeMetadata = readPrimarySchemaMetadata(databasePath);
    const before = openNodeSqliteDatabase(databasePath, { readOnly: true });
    const beforeSchemaVersion = before.prepare("PRAGMA schema_version").get();
    before.close();

    await withAgentDatabaseMaintenanceLease({ env }, (maintenance) =>
      migrateOpenClawAgentDatabaseForMaintenance(
        { agentId: "worker-1", pathname: databasePath },
        maintenance,
      ),
    );

    const after = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(after.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").get()).toEqual(
        beforeMetadata,
      );
      expect(after.prepare("PRAGMA schema_version").get()).toEqual(beforeSchemaVersion);
      expect(
        after.prepare("SELECT name FROM sqlite_schema WHERE name = 'state_leases'").get(),
      ).toBeUndefined();
    } finally {
      after.close();
    }
  });

  it("rejects a foreign state_leases structure without changing it", async () => {
    const { databasePath, env } = createCurrentAgentDatabase();
    const beforeMetadata = readPrimarySchemaMetadata(databasePath);
    const database = openNodeSqliteDatabase(databasePath);
    try {
      database.exec(`
        CREATE TABLE state_leases (
          foreign_id TEXT NOT NULL PRIMARY KEY,
          foreign_payload TEXT NOT NULL
        ) STRICT;
        INSERT INTO state_leases VALUES ('foreign', 'preserve-me');
      `);
    } finally {
      database.close();
    }

    await expect(
      withAgentDatabaseMaintenanceLease({ env }, (maintenance) =>
        migrateOpenClawAgentDatabaseForMaintenance(
          { agentId: "worker-1", pathname: databasePath },
          maintenance,
        ),
      ),
    ).rejects.toThrow(/state_leases.*noncanonical|column definitions differ for state_leases/iu);

    const after = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(after.prepare("SELECT * FROM state_leases").all()).toEqual([
        { foreign_id: "foreign", foreign_payload: "preserve-me" },
      ]);
      expect(after.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").get()).toEqual(
        beforeMetadata,
      );
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    } finally {
      after.close();
    }
  });

  it("rolls back the lease drop when canonical validation fails", async () => {
    const { databasePath, env } = createCurrentAgentDatabase();
    installRetiredLeaseSchema(databasePath);
    const beforeMetadata = readPrimarySchemaMetadata(databasePath);
    const database = openNodeSqliteDatabase(databasePath);
    try {
      database.exec(`
        DROP TABLE session_key_contract;
        CREATE VIEW session_key_contract AS SELECT 1 AS id, 'main' AS main_key, 0 AS updated_at;
      `);
    } finally {
      database.close();
    }

    await expect(
      withAgentDatabaseMaintenanceLease({ env }, (maintenance) =>
        migrateOpenClawAgentDatabaseForMaintenance(
          { agentId: "worker-1", pathname: databasePath },
          maintenance,
        ),
      ),
    ).rejects.toThrow(/session_key_contract/iu);

    const after = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(after.prepare("SELECT scope, lease_key FROM state_leases").all()).toEqual([
        { lease_key: "orphan", scope: "retired" },
      ]);
      expect(
        after
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'index' AND name LIKE 'idx_agent_state_leases_%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "idx_agent_state_leases_expiry" },
        { name: "idx_agent_state_leases_owner" },
      ]);
      expect(after.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").get()).toEqual(
        beforeMetadata,
      );
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    } finally {
      after.close();
    }
  });

  it("repairs the same canonical drift through the writable schema owner", () => {
    const { databasePath, env } = createCurrentAgentDatabase();
    installRetiredLeaseSchema(databasePath);
    expect(
      withOpenClawAgentDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT COUNT(*) AS count FROM state_leases").get(),
        { agentId: "worker-1", env },
      ),
    ).toEqual({ found: true, value: { count: 1 } });
    const beforeWritableOpen = openNodeSqliteDatabase(databasePath, { readOnly: true });
    expect(
      beforeWritableOpen
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'state_leases'")
        .get(),
    ).toEqual({ name: "state_leases" });
    beforeWritableOpen.close();

    const repaired = openOpenClawAgentDatabase({ agentId: "worker-1", env });

    expect(
      repaired.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'state_leases'").get(),
    ).toBeUndefined();
  });
});
