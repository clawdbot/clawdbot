// Compaction must refresh SQLite planner statistics: VACUUM alone preserves
// stale sqlite_stat* rows, which leaves the query planner tuned for a data
// volume that no longer exists after mass deletion (#119720).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { compactDoctorSqliteFile } from "./doctor-sqlite-compact.js";

describe("compactDoctorSqliteFile", () => {
  it("runs ANALYZE so planner statistics reflect the compacted data", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-compact-test-"));
    const sqlitePath = join(dir, "store.sqlite");
    try {
      const seed = openNodeSqliteDatabase(sqlitePath);
      seed.exec("PRAGMA journal_mode = WAL;");
      seed.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, body TEXT);");
      seed.exec("CREATE INDEX entries_body ON entries (body);");
      const insert = seed.prepare("INSERT INTO entries (body) VALUES (?)");
      for (let i = 0; i < 2000; i += 1) {
        insert.run(`row-${i}`);
      }
      // Simulate a mass prune: keep planner-relevant skew by deleting 95%.
      seed.exec("DELETE FROM entries WHERE id % 20 != 0;");
      seed.close();

      const result = compactDoctorSqliteFile({ sqlitePath });
      expect(result.integrityCheck).toBe("ok");

      const verify = openNodeSqliteDatabase(sqlitePath);
      try {
        const statTable = verify
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'")
          .get() as { name?: string } | undefined;
        expect(statTable?.name).toBe("sqlite_stat1");
        const statRows = verify.prepare("SELECT COUNT(*) AS rows FROM sqlite_stat1").get() as {
          rows: number;
        };
        expect(statRows.rows).toBeGreaterThan(0);
      } finally {
        verify.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
