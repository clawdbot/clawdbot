import type { DatabaseSync, StatementSync } from "node:sqlite";
import { vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../src/infra/kysely-sync.js";

/**
 * Count SQLite query executions per caller-defined bucket. Prepared-statement
 * caching (src/infra/kysely-sync.ts) reuses statements across calls, so
 * counting `prepare` invocations undercounts; this wraps `iterate` on matching
 * statements and clears the statement cache at attach so statements cached
 * before the spy cannot bypass it.
 */
export function trackSqliteStatementExecutions<Key extends string>(
  db: DatabaseSync,
  keys: readonly Key[],
  classify: (sql: string) => Key | null,
): { counts: Record<Key, number>; restore: () => void } {
  clearNodeSqliteKyselyCacheForDatabase(db);
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const originalPrepare = db.prepare.bind(db);
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sqlText: string) => {
    const statement = originalPrepare(sqlText);
    const key = classify(sqlText);
    if (key !== null) {
      const originalIterate = statement.iterate.bind(statement) as (
        ...args: unknown[]
      ) => ReturnType<StatementSync["iterate"]>;
      // iterate is overloaded, so the wrapper forwards untyped and casts back.
      statement.iterate = ((...args: unknown[]) => {
        counts[key] += 1;
        return originalIterate(...args);
      }) as StatementSync["iterate"];
    }
    return statement;
  });
  return { counts, restore: () => prepareSpy.mockRestore() };
}
