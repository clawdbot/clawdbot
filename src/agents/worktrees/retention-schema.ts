import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";

const ensuredDatabases = new WeakSet<DatabaseSync>();
const WORKTREE_RETENTION_CLAIMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worktree_retention_claims (
  worktree_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claim_owner TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (worktree_id, claim_id)
) STRICT;
`;

export function ensureWorktreeRetentionClaimsSchema(env: NodeJS.ProcessEnv): void {
  const database = openOpenClawStateDatabase({ env });
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; claim rows use Kysely below.
      db.exec(WORKTREE_RETENTION_CLAIMS_SCHEMA_SQL);
    },
    { env },
    { operationLabel: "worktrees.retention-claims.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}
