import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

/** Permanent session deletion owns all retained receipts, including pre-reset incarnations. */
export function deletePersonalGitHubSessionReceipts(params: {
  agentId: string;
  sessionKeys: readonly string[];
  env?: NodeJS.ProcessEnv;
}): void {
  const database = openOpenClawStateDatabase({ env: params.env });
  const tables = [
    "github_personal_publication_requests",
    "github_repository_publication_requests",
  ] as const;
  const existing = tables.filter((table) => tableExists(database.db, table));
  if (existing.length === 0 || params.sessionKeys.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      for (const table of existing) {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, typeof table>>(db)
            .deleteFrom(table)
            .where("agent_id", "=", params.agentId)
            .where("session_key", "in", params.sessionKeys),
        );
      }
    },
    { database },
    { operationLabel: "github-personal-publication.session-delete" },
  );
}
