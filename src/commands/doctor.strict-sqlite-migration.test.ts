import { afterEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

it("doctor upgrades BLOB-stored TEXT values to STRICT storage", async () => {
  await withOpenClawTestState({ label: "doctor-strict-blob" }, async (state) => {
    const current = openOpenClawStateDatabase({ env: state.env });
    const databasePath = current.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE workspace_path_aliases;
      CREATE TABLE workspace_path_aliases (
        alias_key TEXT NOT NULL PRIMARY KEY,
        alias_path TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
      UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
    `);
    legacy
      .prepare(
        `INSERT INTO workspace_path_aliases (
           alias_key, alias_path, workspace_key, workspace_path, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-alias",
        Buffer.from("/tmp/legacy-alias"),
        "legacy-workspace",
        "/tmp/legacy-workspace",
        20,
      );
    legacy.close();

    const result = await autoMigrateLegacyState({
      cfg: {},
      env: state.env,
      homedir: () => state.home,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Migrated shared state tables to SQLite STRICT typing (1)");

    const migrated = openOpenClawStateDatabase({ env: state.env });
    expect(
      migrated.db
        .prepare(
          `SELECT alias_path, typeof(alias_path) AS storage_type
           FROM workspace_path_aliases WHERE alias_key = 'legacy-alias'`,
        )
        .get(),
    ).toEqual({ alias_path: "/tmp/legacy-alias", storage_type: "text" });
  });
});
