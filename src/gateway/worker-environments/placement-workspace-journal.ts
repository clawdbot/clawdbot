import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { getRequired } from "./placement-row-codec.js";
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

function assertJournalOwner(db: DatabaseSync, owner: WorkerWorkspaceJournalOwner) {
  const placement = getRequired(db, owner.sessionId);
  if (
    (placement.state !== "active" && placement.state !== "draining") ||
    placement.environmentId !== owner.environmentId ||
    placement.activeOwnerEpoch !== owner.ownerEpoch ||
    placement.generation !== owner.placementGeneration
  ) {
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

    loadWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
    ): WorkerWorkspaceReconciliationJournal | undefined {
      const db = read();
      const placement = assertJournalOwner(db, owner);
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

    abortWorkspaceReconciliation(owner: WorkerWorkspaceJournalOwner): void {
      write((db) => {
        assertJournalOwner(db, owner);
        clearWorkerWorkspaceReconciliation(db, owner.sessionId);
      });
    },
  };
}
