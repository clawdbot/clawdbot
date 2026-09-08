import { existsSync } from "node:fs";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

/** Records an explicit non-Claw claim through the canonical MCP owner. */
export function markClawMcpServerIndependentlyOwned(
  name: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): number {
  const databasePath = options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env);
  if (!existsSync(databasePath)) {
    return 0;
  }
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const result = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "claw_mcp_server_refs">>(db)
          .updateTable("claw_mcp_server_refs")
          .set({ independent_owner: 1, updated_at_ms: options.nowMs ?? Date.now() })
          .where("name", "=", name)
          .where("independent_owner", "!=", 1),
      );
      return Number(result.numAffectedRows);
    }, options);
  } catch {
    // The canonical MCP write already succeeded; Claw status still detects config drift.
    return 0;
  }
}
