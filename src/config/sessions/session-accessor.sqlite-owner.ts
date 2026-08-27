import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionCreatedActor, SessionOwnerAssignment } from "./session-entry-provenance.js";

export function replaceSessionOwnerInTransaction(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  owner: SessionOwnerAssignment | undefined,
): boolean {
  if (!hasSqliteSessionOwnerColumns(database.db)) {
    if (!owner?.actor.id) {
      return false;
    }
    for (const { columnName, dataType, tableName } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
      ensureColumn(database.db, tableName, `${columnName} ${dataType}`);
    }
  }
  const result = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .updateTable("session_nodes")
      .set({
        owner_actor_type: owner?.actor.type ?? null,
        owner_actor_id: owner?.actor.id ?? null,
        owner_assigned_by_type: owner?.assignedBy?.type ?? null,
        owner_assigned_by_id: owner?.assignedBy?.id ?? null,
        owner_assigned_at: owner?.assignedAt ?? null,
      })
      .where("session_key", "=", sessionKey),
  );
  if (result.numAffectedRows !== 1n) {
    return false;
  }
  publishSessionEntryCacheInvalidation(database);
  return true;
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
  return runOpenClawAgentWriteTransaction(
    (database) => {
      params.assertCurrent?.();
      const currentAssignedAt = hasSqliteSessionOwnerColumns(database.db)
        ? executeSqliteQueryTakeFirstSync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_nodes")
              .select("owner_assigned_at")
              .where("session_key", "=", resolved.sessionKey),
          )?.owner_assigned_at
        : undefined;
      const requestedAssignedAt = params.assignedAt ?? Date.now();
      const owner: SessionOwnerAssignment = {
        actor: params.owner,
        assignedBy: params.assignedBy,
        assignedAt:
          typeof currentAssignedAt === "number"
            ? Math.max(requestedAssignedAt, currentAssignedAt + 1)
            : requestedAssignedAt,
      };
      return replaceSessionOwnerInTransaction(database, resolved.sessionKey, owner) ? owner : null;
    },
    options,
    { operationLabel: "sessions.assign-owner" },
  );
}
