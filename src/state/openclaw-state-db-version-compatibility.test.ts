import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";

afterEach(() => {
  vi.doUnmock("./openclaw-state-db-contract.js");
  vi.resetModules();
});

describe("state database version compatibility", () => {
  it("makes a v7 reader refuse v8 before workspace rollback-journal pruning", async () => {
    vi.resetModules();
    vi.doMock("./openclaw-state-db-contract.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./openclaw-state-db-contract.js")>();
      return { ...actual, OPENCLAW_STATE_SCHEMA_VERSION: 7 };
    });
    const { assertSupportedSchemaVersion } = await import("./openclaw-state-db-maintenance.js");
    const { DatabaseSync } = requireNodeSqlite();
    const database: DatabaseSync = new DatabaseSync(":memory:");
    database.exec(`
      PRAGMA user_version = 8;
      CREATE TABLE worker_workspace_reconciliations (
        session_id TEXT PRIMARY KEY,
        base_pack BLOB NOT NULL
      ) STRICT;
      INSERT INTO worker_workspace_reconciliations VALUES ('retained-session', X'00');
    `);
    const pruneLegacyJournals = vi.fn(() => {
      database.exec("DELETE FROM worker_workspace_reconciliations;");
    });

    try {
      expect(() => {
        assertSupportedSchemaVersion(database, "/state/openclaw.sqlite");
        pruneLegacyJournals();
      }).toThrow(/newer schema version 8; this build supports 7/iu);
      expect(pruneLegacyJournals).not.toHaveBeenCalled();
      expect(
        database.prepare("SELECT session_id FROM worker_workspace_reconciliations").get(),
      ).toEqual({ session_id: "retained-session" });
    } finally {
      database.close();
    }
  });
});
