import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { find, getRequired } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import {
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-reconcile.js";

type WorkspaceJournalDatabase = Pick<
  StateDatabase,
  "worker_session_placements" | "worker_workspace_reconciliations"
>;

const query = (db: DatabaseSync) => getNodeSqliteKysely<WorkspaceJournalDatabase>(db);

type WorkerWorkspaceJournalOwner = {
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
};

function isCurrentJournalOwner(
  placement: WorkerSessionPlacementRecord | undefined,
  owner: WorkerWorkspaceJournalOwner,
): boolean {
  // Only the original active/draining generation may apply these rollback bytes.
  // Drain/reconcile advances generation, making the prior journal permanently stale.
  return (
    (placement?.state === "active" || placement?.state === "draining") &&
    placement.environmentId === owner.environmentId &&
    placement.activeOwnerEpoch === owner.ownerEpoch &&
    placement.generation === owner.placementGeneration
  );
}

function assertJournalOwner(
  db: DatabaseSync,
  owner: WorkerWorkspaceJournalOwner,
  options: { allowFailedOwner?: boolean } = {},
) {
  const placement = getRequired(db, owner.sessionId);
  const isCurrentOwner = isCurrentJournalOwner(placement, owner);
  // Forced teardown advances the exact owner to failed before best-effort
  // rollback. Admit that state without weakening the manifest checks below.
  const isAllowedFailedOwner =
    options.allowFailedOwner === true &&
    placement.state === "failed" &&
    placement.generation > owner.placementGeneration &&
    placement.environmentId === owner.environmentId &&
    placement.activeOwnerEpoch === owner.ownerEpoch;
  if (!isCurrentOwner && !isAllowedFailedOwner) {
    throw new Error(`Cannot reconcile stale worker workspace for session ${owner.sessionId}`);
  }
  return placement;
}

export function clearWorkerWorkspaceReconciliation(
  db: DatabaseSync,
  sessionId: string,
  currentManifestRef?: string,
): void {
  const existing = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_reconciliations")
      .select("current_manifest_ref")
      .where("session_id", "=", sessionId),
  ).rows[0];
  if (existing && currentManifestRef && existing.current_manifest_ref !== currentManifestRef) {
    throw new Error(`Worker workspace journal result changed for session ${sessionId}`);
  }
  executeSqliteQuerySync(
    db,
    query(db).deleteFrom("worker_workspace_reconciliations").where("session_id", "=", sessionId),
  );
}

export function createPlacementWorkspaceJournalOps(runtime: PlacementStoreRuntime) {
  const { now, read, write } = runtime;
  return {
    listWorkspaceReconciliationOwners(): WorkerWorkspaceJournalOwner[] {
      const db = read();
      return executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_workspace_reconciliations")
          .select(["session_id", "environment_id", "owner_epoch", "placement_generation"])
          .orderBy("session_id"),
      ).rows.map((row) => ({
        sessionId: row.session_id,
        environmentId: row.environment_id,
        ownerEpoch: row.owner_epoch,
        placementGeneration: row.placement_generation,
      }));
    },

    pruneOrphanedWorkspaceReconciliations(options: {
      retainFailedOwner: (recoveryError: string) => boolean;
    }): WorkerWorkspaceJournalOwner[] {
      return write((db) => {
        const rows = executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_workspace_reconciliations")
            .select(["session_id", "environment_id", "owner_epoch", "placement_generation"])
            .orderBy("session_id"),
        ).rows;
        const pruned: WorkerWorkspaceJournalOwner[] = [];
        for (const row of rows) {
          const owner = {
            sessionId: row.session_id,
            environmentId: row.environment_id,
            ownerEpoch: row.owner_epoch,
            placementGeneration: row.placement_generation,
          };
          const placement = find(db, owner.sessionId);
          const stillOwned = isCurrentJournalOwner(placement, owner);
          const retainedFailedOwner =
            placement?.state === "failed" &&
            placement.environmentId === owner.environmentId &&
            placement.activeOwnerEpoch === owner.ownerEpoch &&
            placement.generation > owner.placementGeneration &&
            options.retainFailedOwner(placement.recoveryError);
          if (stillOwned || retainedFailedOwner) {
            continue;
          }
          // Generation and owner epoch only advance, so a mismatched exact owner cannot rebind.
          const deleted = executeSqliteQuerySync(
            db,
            query(db)
              .deleteFrom("worker_workspace_reconciliations")
              .where("session_id", "=", owner.sessionId)
              .where("environment_id", "=", owner.environmentId)
              .where("owner_epoch", "=", owner.ownerEpoch)
              .where("placement_generation", "=", owner.placementGeneration),
          );
          if (deleted.numAffectedRows === 1n) {
            pruned.push(owner);
          }
        }
        return pruned;
      });
    },

    loadWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
      options: { allowFailedOwner?: boolean } = {},
    ): WorkerWorkspaceReconciliationJournal | undefined {
      const db = read();
      const placement = assertJournalOwner(db, owner, options);
      const row = executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_workspace_reconciliations")
          .selectAll()
          .where("session_id", "=", owner.sessionId),
      ).rows[0];
      if (!row) {
        return undefined;
      }
      const plan = parseWorkerWorkspaceReconciliationPlan(row.plan_json);
      if (
        row.environment_id !== owner.environmentId ||
        row.owner_epoch !== owner.ownerEpoch ||
        row.placement_generation !== owner.placementGeneration ||
        (placement.workspaceBaseManifestRef !== row.base_manifest_ref &&
          placement.workspaceBaseManifestRef !== plan.appliedManifestRef)
      ) {
        throw new Error(`Worker workspace journal owner is stale for session ${owner.sessionId}`);
      }
      if (
        plan.baseManifestRef !== row.base_manifest_ref ||
        plan.currentManifestRef !== row.current_manifest_ref
      ) {
        throw new Error(`Worker workspace journal metadata is inconsistent for ${owner.sessionId}`);
      }
      if (
        row.base_pack.byteLength > 256 * 1024 * 1024 ||
        createHash("sha256").update(row.base_pack).digest("hex") !== plan.basePackSha256
      ) {
        throw new Error(`Worker workspace journal snapshot is invalid for ${owner.sessionId}`);
      }
      return { ...plan, basePack: row.base_pack };
    },

    beginWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
      journal: WorkerWorkspaceReconciliationJournal,
    ): void {
      if (journal.appliedManifestRef) {
        throw new Error("Worker workspace reconciliation cannot begin as already applied");
      }
      write((db) => {
        const placement = assertJournalOwner(db, owner);
        if (placement.workspaceBaseManifestRef !== journal.baseManifestRef) {
          throw new Error(`Worker workspace base changed for session ${owner.sessionId}`);
        }
        const inserted = executeSqliteQuerySync(
          db,
          query(db)
            .insertInto("worker_workspace_reconciliations")
            .values({
              session_id: owner.sessionId,
              environment_id: owner.environmentId,
              owner_epoch: owner.ownerEpoch,
              placement_generation: owner.placementGeneration,
              base_manifest_ref: journal.baseManifestRef,
              current_manifest_ref: journal.currentManifestRef,
              plan_json: serializeWorkerWorkspaceReconciliationPlan(journal),
              base_pack: journal.basePack,
              created_at_ms: now(),
            })
            .onConflict((conflict) => conflict.column("session_id").doNothing()),
        );
        if (inserted.numAffectedRows !== 1n) {
          throw new Error(
            `Worker workspace reconciliation is already pending for ${owner.sessionId}`,
          );
        }
      });
    },

    abortWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
      options: { force?: boolean } = {},
    ): void {
      write((db) => {
        if (!options.force) {
          assertJournalOwner(db, owner);
          clearWorkerWorkspaceReconciliation(db, owner.sessionId);
          return;
        }
        // Forced teardown owns this exact durable journal even when placement
        // state advanced after a failed recovery sweep.
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .deleteFrom("worker_workspace_reconciliations")
            .where("session_id", "=", owner.sessionId)
            .where("environment_id", "=", owner.environmentId)
            .where("owner_epoch", "=", owner.ownerEpoch)
            .where("placement_generation", "=", owner.placementGeneration),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker workspace journal changed for ${owner.sessionId}`);
        }
      });
    },
  };
}
