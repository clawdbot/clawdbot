import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { ensureColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionCreatedActor, SessionOwnerAssignment } from "./session-entry-provenance.js";
const ensuredOwnerDatabases = new WeakSet<DatabaseSync>();

function ensureSessionOwnerColumns(database: DatabaseSync): void {
  if (ensuredOwnerDatabases.has(database)) {
    return;
  }
  for (const { columnName, dataType, tableName } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
    ensureColumn(database, tableName, `${columnName} ${dataType}`);
  }
}

export function assignSessionOwner(
  scope: SessionAccessScope,
  params: {
    owner: SessionCreatedActor & { id: string };
    assignedBy: SessionCreatedActor & { id: string };
    assignedAt?: number;
    assertCurrent?: () => void;
  },
): SessionOwnerAssignment | null {
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const opened = openOpenClawAgentDatabase(options);
  const assignedAt = params.assignedAt ?? Date.now();
  const owner: SessionOwnerAssignment = {
    actor: params.owner,
    assignedBy: params.assignedBy,
    assignedAt,
  };
  let ensured = false;
  const updated = runOpenClawAgentWriteTransaction(
    (database) => {
      if (!ensuredOwnerDatabases.has(database.db)) {
        ensureSessionOwnerColumns(database.db);
        ensured = true;
      }
      params.assertCurrent?.();
      const result = executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .updateTable("session_nodes")
          .set({
            owner_actor_type: params.owner.type,
            owner_actor_id: params.owner.id,
            owner_assigned_by_type: params.assignedBy.type,
            owner_assigned_by_id: params.assignedBy.id,
            owner_assigned_at: assignedAt,
          })
          .where("session_key", "=", resolved.sessionKey),
      );
      if (result.numAffectedRows === 1n) {
        publishSessionEntryCacheInvalidation(database);
        return true;
      }
      return false;
    },
    options,
    { operationLabel: "sessions.assign-owner" },
  );
  if (ensured) {
    ensuredOwnerDatabases.add(opened.db);
  }
  return updated ? owner : null;
}
