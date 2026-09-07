import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { ensureNodeWorkerPreparedWorkspaceSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  NodeWorkerPreparedWorkspaceBinding,
  NodeWorkerPreparedWorkspaceRegistration,
} from "../worker/node-workspace-prepared-protocol.js";

type PreparedDatabase = Pick<DB, "node_worker_prepared_workspaces">;
export type NodeWorkerPreparedWorkspaceRow = Selectable<DB["node_worker_prepared_workspaces"]>;
const TABLE = "node_worker_prepared_workspaces";

function query(db: DatabaseSync) {
  return getNodeSqliteKysely<PreparedDatabase>(db);
}

function selectRow(db: DatabaseSync, preparationKey: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db).selectFrom(TABLE).selectAll().where("preparation_key", "=", preparationKey),
  );
}

function requireUnchanged(db: DatabaseSync, expected: NodeWorkerPreparedWorkspaceRow) {
  const row = selectRow(db, expected.preparation_key);
  if (!row || JSON.stringify(row) !== JSON.stringify(expected)) {
    throw new Error("INVALID_REQUEST: prepared workspace ownership changed");
  }
  return row;
}

/** One fresh dedicated node owns one immutable registration and one session binding. */
export class NodeWorkerPreparedWorkspaceStore {
  constructor(private readonly options: OpenClawStateDatabaseOptions) {}

  find(environmentId: string): NodeWorkerPreparedWorkspaceRow | undefined {
    return withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, TABLE)) {
        return undefined;
      }
      const rows = executeSqliteQuerySync(
        db,
        query(db).selectFrom(TABLE).selectAll().limit(2),
      ).rows;
      if (rows.length > 1 || (rows[0] && rows[0].environment_id !== environmentId)) {
        throw new Error("INVALID_REQUEST: this prepared node belongs to another environment");
      }
      return rows[0];
    }, this.options);
  }

  list(gatewayNamespace: string): NodeWorkerPreparedWorkspaceRow[] {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
        if (!tableExists(db, TABLE)) {
          return [];
        }
        return executeSqliteQuerySync(
          db,
          query(db).selectFrom(TABLE).selectAll().where("gateway_namespace", "=", gatewayNamespace),
        ).rows;
      }, this.options) ?? []
    );
  }

  register(input: NodeWorkerPreparedWorkspaceRegistration): NodeWorkerPreparedWorkspaceRow {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        ensureNodeWorkerPreparedWorkspaceSchema(db);
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          query(db).selectFrom(TABLE).selectAll().limit(1),
        );
        if (existing) {
          if (
            existing.state !== "available" ||
            existing.preparation_key !== input.preparationKey ||
            existing.cache_key !== input.cacheKey ||
            existing.gateway_namespace !== input.gatewayNamespace ||
            existing.environment_id !== input.environmentId ||
            existing.workspace_dir !== input.workspaceDir ||
            existing.home_dir !== input.homeDir ||
            existing.source_manifest_ref !== input.sourceManifestRef
          ) {
            throw new Error("INVALID_REQUEST: this node already owns a prepared workspace");
          }
          return existing;
        }
        const row = {
          preparation_key: input.preparationKey,
          cache_key: input.cacheKey,
          gateway_namespace: input.gatewayNamespace,
          environment_id: input.environmentId,
          workspace_dir: input.workspaceDir,
          home_dir: input.homeDir,
          source_manifest_ref: input.sourceManifestRef,
          state: "available",
          session_id: null,
          session_key: null,
          owner_epoch: null,
          created_at_ms: Date.now(),
          bound_at_ms: null,
          retired_at_ms: null,
        };
        executeSqliteQuerySync(db, query(db).insertInto(TABLE).values(row));
        return selectRow(db, input.preparationKey)!;
      },
      this.options,
      { operationLabel: "prepared-workspace.register" },
    );
  }

  bind(input: NodeWorkerPreparedWorkspaceBinding): NodeWorkerPreparedWorkspaceRow {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (!tableExists(db, TABLE)) {
          throw new Error("INVALID_REQUEST: prepared workspace registration is missing");
        }
        const row = selectRow(db, input.preparationKey);
        if (
          !row ||
          row.cache_key !== input.cacheKey ||
          row.gateway_namespace !== input.gatewayNamespace ||
          row.environment_id !== input.environmentId
        ) {
          throw new Error(
            "INVALID_REQUEST: prepared workspace registration does not match this environment",
          );
        }
        if (
          row.state === "bound" &&
          row.session_id === input.sessionId &&
          row.session_key === input.sessionKey &&
          row.owner_epoch === input.ownerEpoch
        ) {
          return row;
        }
        if (
          row.state !== "available" ||
          row.session_id !== null ||
          row.session_key !== null ||
          row.owner_epoch !== null ||
          row.bound_at_ms !== null
        ) {
          throw new Error("INVALID_REQUEST: prepared workspace has already been consumed");
        }
        const bound = {
          ...row,
          state: "bound",
          session_id: input.sessionId,
          session_key: input.sessionKey,
          owner_epoch: input.ownerEpoch,
          bound_at_ms: Math.max(Date.now(), row.created_at_ms),
        };
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable(TABLE)
            .set(bound)
            .where("preparation_key", "=", input.preparationKey),
        );
        return bound;
      },
      this.options,
      { operationLabel: "prepared-workspace.bind" },
    );
  }

  /** A lost mutation permit remains retiring after restart; only verified completion may reopen it. */
  beginMutation(expected: NodeWorkerPreparedWorkspaceRow): {
    complete: () => void;
    close: () => void;
  } {
    if (expected.state !== "bound") {
      throw new Error("INVALID_REQUEST: prepared workspace is not bound");
    }
    const retiring = this.retire(expected);
    let open = true;
    return {
      complete: () => {
        if (!open) {
          throw new Error("INVALID_REQUEST: prepared workspace mutation is closed");
        }
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            requireUnchanged(db, retiring);
            executeSqliteQuerySync(
              db,
              query(db)
                .updateTable(TABLE)
                .set({ state: "bound" })
                .where("preparation_key", "=", retiring.preparation_key),
            );
          },
          this.options,
          { operationLabel: "prepared-workspace.finish-mutation" },
        );
        open = false;
      },
      close: () => {
        open = false;
      },
    };
  }

  retire(
    expected: NodeWorkerPreparedWorkspaceRow,
    completed = false,
  ): NodeWorkerPreparedWorkspaceRow {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const row = requireUnchanged(db, expected);
        if (row.state === "retired") {
          return row;
        }
        const retired = {
          ...row,
          state: completed ? "retired" : "retiring",
          retired_at_ms: completed
            ? Math.max(Date.now(), row.bound_at_ms ?? row.created_at_ms)
            : null,
        };
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable(TABLE)
            .set(retired)
            .where("preparation_key", "=", row.preparation_key),
        );
        return retired;
      },
      this.options,
      { operationLabel: "prepared-workspace.retire" },
    );
  }
}
