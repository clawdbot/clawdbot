// Covers doctor repair of databases missing first-use additive columns while
// the STRICT migration rebuilds their tables.
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("first-use additive column STRICT migration", () => {
  it("repairs device_bootstrap_tokens without setup_id while migrating to STRICT", () => {
    const stateDir = tempDirs.make("openclaw-state-first-use-column-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = openOpenClawStateDatabase(options).path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    const strictCreateSql = (
      legacy
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'device_bootstrap_tokens'",
        )
        .get() as { sql: string }
    ).sql;
    // Reproduce a database created before setup_id shipped: no STRICT, no setup_id.
    const legacyCreateSql = strictCreateSql
      .replace(/\s+STRICT$/u, "")
      .replace(/\n\s*setup_id TEXT,/u, "");
    expect(legacyCreateSql).not.toBe(strictCreateSql);
    expect(legacyCreateSql).not.toContain("setup_id");

    legacy.exec(`
      DROP INDEX idx_device_bootstrap_tokens_ts;
      ALTER TABLE device_bootstrap_tokens RENAME TO device_bootstrap_tokens_strict;
      ${legacyCreateSql};
      DROP TABLE device_bootstrap_tokens_strict;
      PRAGMA user_version = 2;
      UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
    `);
    legacy
      .prepare(
        `INSERT INTO device_bootstrap_tokens (token_key, token, ts, issued_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run("bootstrap", "token-value", 1_000, 1_000);
    legacy.close();

    // Before the fix this returns a warning and applies nothing, which leaves the
    // whole repair rolled back and re-reports an unrelated audit-events migration.
    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);

    const migrated = openOpenClawStateDatabase(options);
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'device_bootstrap_tokens'")
        .get(),
    ).toEqual({ strict: 1 });
    // The rebuilt table comes from canonical SQL, so the column exists afterwards
    // and the pre-existing row survives with a NULL correlation id.
    expect(
      migrated.db.prepare("SELECT token_key, token, setup_id FROM device_bootstrap_tokens").all(),
    ).toEqual([{ token_key: "bootstrap", token: "token-value", setup_id: null }]);
  });
});
