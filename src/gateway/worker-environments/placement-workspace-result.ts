import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  ensureRepositoryWorkspacePendingResultSchema,
  hasRepositoryWorkspacePendingResultSchema,
} from "../../state/openclaw-state-db-schema-additive.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  isCurrentPlacementTurnClaim,
  placementTurnOwner,
  resolvePlacementTurnEnvironment,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { getRequired } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { clearWorkerWorkspaceReconciliation } from "./placement-workspace-journal.js";

type WorkspaceResultDatabase = Pick<
  StateDatabase,
  "worker_session_placements" | "worker_workspace_pending_results" | "session_repository_workspaces"
>;

const query = (db: DatabaseSync) => getNodeSqliteKysely<WorkspaceResultDatabase>(db);

export type WorkerWorkspacePendingResult = {
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
  claimId: string;
  runId: string;
  gatewayInstanceId: string;
  recoveryRequestedAtMs: number | null;
  workspaceAcceptedAtMs: number | null;
  stagedResultRef: string | null;
  repositoryWorkspaceId?: string;
};

function matchesWorkspaceResultGeneration(
  placement: WorkerSessionPlacementRecord,
  generation: number,
): boolean {
  // Reclaim reserves after drain; ordinary turns reserve before it. Both exact
  // durable result generations remain recoverable without restoring live authority.
  return (
    (placement.state === "active" || placement.state === "draining") &&
    (placement.generation === generation ||
      (placement.state === "draining" && placement.generation === generation + 1))
  );
}

export function isCurrentWorkerWorkspacePendingResultOwner(
  placement: WorkerSessionPlacementRecord | undefined,
  pending: WorkerWorkspacePendingResult,
): placement is Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }> {
  if (
    (placement?.state !== "active" && placement?.state !== "draining") ||
    placement.sessionId !== pending.sessionId ||
    placement.environmentId !== pending.environmentId ||
    placement.activeOwnerEpoch !== pending.ownerEpoch
  ) {
    return false;
  }
  if (placement.turnClaim) {
    // Reclaim claims after drain; worker turns claim before it. The exact live
    // claim owns either generation shape without weakening claimless recovery.
    return isCurrentPlacementTurnClaim(placement, {
      sessionId: pending.sessionId,
      claimId: pending.claimId,
      runId: pending.runId,
      placementGeneration: pending.placementGeneration,
      owner: placementTurnOwner(placement),
    });
  }
  return matchesWorkspaceResultGeneration(placement, pending.placementGeneration);
}

function matchesWorkspaceResultClaim(
  placement: WorkerSessionPlacementRecord,
  row: StateDatabase["worker_workspace_pending_results"],
  claim: WorkerSessionTurnClaim,
): boolean {
  const recoveryOwner =
    placement.state === "active" || placement.state === "draining"
      ? placementTurnOwner(placement)
      : undefined;
  return (
    row.session_id === claim.sessionId &&
    row.environment_id === placement.environmentId &&
    row.owner_epoch === placement.activeOwnerEpoch &&
    row.placement_generation === claim.placementGeneration &&
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    (isCurrentPlacementTurnClaim(placement, claim) ||
      // Restart revokes local authority; only the exact durable result may finish.
      (matchesWorkspaceResultGeneration(placement, claim.placementGeneration) &&
        placement.turnClaim === null &&
        recoveryOwner?.kind === "local" &&
        claim.owner.kind === "local" &&
        claim.owner.environmentId === recoveryOwner.environmentId &&
        claim.owner.ownerEpoch === recoveryOwner.ownerEpoch))
  );
}

export function hasCurrentWorkspaceResultClaim(
  db: DatabaseSync,
  claim: WorkerSessionTurnClaim,
): boolean {
  const placement = getRequired(db, claim.sessionId);
  const row = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .selectAll()
      .where("session_id", "=", claim.sessionId),
  ).rows[0];
  return Boolean(row && matchesWorkspaceResultClaim(placement, row, claim));
}

export function clearWorkerWorkspacePendingResult(db: DatabaseSync, sessionId: string): void {
  executeSqliteQuerySync(
    db,
    query(db).deleteFrom("worker_workspace_pending_results").where("session_id", "=", sessionId),
  );
}

export function hasWorkerWorkspacePendingResult(db: DatabaseSync, sessionId: string): boolean {
  return Boolean(
    executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_workspace_pending_results")
        .select("session_id")
        .where("session_id", "=", sessionId),
    ).rows[0],
  );
}

export function hasAcceptedWorkerWorkspacePendingResult(
  db: DatabaseSync,
  sessionId: string,
): boolean {
  return Boolean(
    executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_workspace_pending_results")
        .select("session_id")
        .where("session_id", "=", sessionId)
        .where("workspace_accepted_at_ms", "is not", null),
    ).rows[0],
  );
}

export function insertWorkerWorkspacePendingResult(
  db: DatabaseSync,
  claim: WorkerSessionTurnClaim,
  nowMs: number,
  gatewayInstanceId: string,
): void {
  const placement = getRequired(db, claim.sessionId);
  const environment = resolvePlacementTurnEnvironment(placement, claim);
  if (!environment) {
    throw new Error(`Cannot retain stale worker workspace result for ${claim.sessionId}`);
  }
  const { environmentId, ownerEpoch } = environment;
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("worker_workspace_pending_results")
      .values({
        session_id: claim.sessionId,
        environment_id: environmentId,
        owner_epoch: ownerEpoch,
        placement_generation: claim.placementGeneration,
        claim_id: claim.claimId,
        run_id: claim.runId,
        gateway_instance_id: gatewayInstanceId,
        recovery_requested_at_ms: null,
        workspace_accepted_at_ms: null,
        staged_result_ref: null,
        created_at_ms: nowMs,
      })
      .onConflict((conflict) => conflict.column("session_id").doNothing()),
  );
  if (result.numAffectedRows === 1n) {
    return;
  }
  const existing = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .selectAll()
      .where("session_id", "=", claim.sessionId),
  ).rows[0];
  if (
    !existing ||
    existing.environment_id !== environmentId ||
    existing.owner_epoch !== ownerEpoch ||
    existing.placement_generation !== claim.placementGeneration ||
    existing.claim_id !== claim.claimId ||
    existing.run_id !== claim.runId
  ) {
    throw new Error(`Worker workspace result is already pending for ${claim.sessionId}`);
  }
}

function markWorkerWorkspacePendingResultAccepted(
  db: DatabaseSync,
  claim: WorkerSessionTurnClaim,
  nowMs: number,
): void {
  const placement = getRequired(db, claim.sessionId);
  const environment = resolvePlacementTurnEnvironment(placement, claim);
  if (!environment && !hasCurrentWorkspaceResultClaim(db, claim)) {
    throw new Error(`Cannot accept stale worker workspace result for ${claim.sessionId}`);
  }
  const environmentId = environment?.environmentId ?? placement.environmentId!;
  const ownerEpoch = environment?.ownerEpoch ?? placement.activeOwnerEpoch!;
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_workspace_pending_results")
      .set({ workspace_accepted_at_ms: nowMs })
      .where("session_id", "=", claim.sessionId)
      .where("environment_id", "=", environmentId)
      .where("owner_epoch", "=", ownerEpoch)
      .where("placement_generation", "=", claim.placementGeneration)
      .where("claim_id", "=", claim.claimId)
      .where("run_id", "=", claim.runId),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Cannot accept stale worker workspace result for ${claim.sessionId}`);
  }
}

export function createPlacementWorkspaceResultOps(runtime: PlacementStoreRuntime) {
  const { instanceId, now, read, write } = runtime;
  const assertPendingClaim = (db: DatabaseSync, claim: WorkerSessionTurnClaim) => {
    const placement = getRequired(db, claim.sessionId);
    const row = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_workspace_pending_results")
        .selectAll()
        .where("session_id", "=", claim.sessionId),
    ).rows[0];
    if (!row || !matchesWorkspaceResultClaim(placement, row, claim)) {
      throw new Error(`Cannot update stale worker workspace result for ${claim.sessionId}`);
    }
    return row;
  };
  return {
    workspaceResultInstanceId(): string {
      return instanceId;
    },

    validateWorkspaceResultClaim(claim: WorkerSessionTurnClaim): boolean {
      return hasCurrentWorkspaceResultClaim(read(), claim);
    },

    listPendingWorkspaceResults(): WorkerWorkspacePendingResult[] {
      const db = read();
      return executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_workspace_pending_results")
          .select([
            "session_id",
            "environment_id",
            "owner_epoch",
            "placement_generation",
            "claim_id",
            "run_id",
            "gateway_instance_id",
            "recovery_requested_at_ms",
            "workspace_accepted_at_ms",
            "staged_result_ref",
          ])
          .$if(hasRepositoryWorkspacePendingResultSchema(db), (builder) =>
            builder.select("repository_workspace_id"),
          )
          .orderBy("session_id"),
      ).rows.map((row) => {
        const result: WorkerWorkspacePendingResult = {
          sessionId: row.session_id,
          environmentId: row.environment_id,
          ownerEpoch: row.owner_epoch,
          placementGeneration: row.placement_generation,
          claimId: row.claim_id,
          runId: row.run_id,
          gatewayInstanceId: row.gateway_instance_id,
          recoveryRequestedAtMs: row.recovery_requested_at_ms,
          workspaceAcceptedAtMs: row.workspace_accepted_at_ms,
          stagedResultRef: row.staged_result_ref,
        };
        if (row.repository_workspace_id) {
          result.repositoryWorkspaceId = row.repository_workspace_id;
        }
        return result;
      });
    },

    markWorkspaceResultPending(claim: WorkerSessionTurnClaim): void {
      write((db) => {
        insertWorkerWorkspacePendingResult(db, claim, now(), instanceId);
      });
    },

    recordStagedWorkspaceResult(
      claim: WorkerSessionTurnClaim,
      stagedResultRef: string,
      repositoryWorkspaceId?: string,
    ): void {
      if (!/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(stagedResultRef)) {
        throw new Error("Worker workspace staged result reference is invalid");
      }
      if (repositoryWorkspaceId !== undefined && !/^[a-f0-9-]{36}$/u.test(repositoryWorkspaceId)) {
        throw new Error("Worker workspace result repository identity is invalid");
      }
      write((db) => {
        if (repositoryWorkspaceId !== undefined) {
          ensureRepositoryWorkspacePendingResultSchema(db);
        }
        const pending = assertPendingClaim(db, claim);
        if (pending.workspace_accepted_at_ms !== null) {
          throw new Error(`Cannot restage accepted worker workspace result for ${claim.sessionId}`);
        }
        if (
          pending.staged_result_ref &&
          (pending.staged_result_ref !== stagedResultRef ||
            (pending.repository_workspace_id ?? undefined) !== repositoryWorkspaceId)
        ) {
          throw new Error(`Worker workspace result ref changed for ${claim.sessionId}`);
        }
        if (repositoryWorkspaceId !== undefined) {
          const placement = getRequired(db, claim.sessionId);
          const repository = executeSqliteQuerySync(
            db,
            query(db)
              .selectFrom("session_repository_workspaces")
              .select(["agent_id", "session_key"])
              .where("workspace_id", "=", repositoryWorkspaceId),
          ).rows[0];
          if (
            !repository ||
            repository.agent_id !== placement.agentId ||
            repository.session_key !== placement.sessionKey
          ) {
            throw new Error(
              `Worker workspace result repository owner changed for ${claim.sessionId}`,
            );
          }
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_workspace_pending_results")
            .set({
              staged_result_ref: stagedResultRef,
              ...(repositoryWorkspaceId ? { repository_workspace_id: repositoryWorkspaceId } : {}),
            })
            .where("session_id", "=", claim.sessionId)
            .where("claim_id", "=", claim.claimId)
            .where("run_id", "=", claim.runId),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Cannot stage stale worker workspace result for ${claim.sessionId}`);
        }
      });
    },

    acceptWorkspaceResult(claim: WorkerSessionTurnClaim): void {
      write((db) => {
        assertPendingClaim(db, claim);
        markWorkerWorkspacePendingResultAccepted(db, claim, now());
        // Keep the applied journal as the crash-safe marker until this fence is
        // accepted. Recovery then inspects reality instead of replaying a result.
        clearWorkerWorkspaceReconciliation(db, claim.sessionId);
      });
    },

    handoffWorkspaceResultRecovery(claim: WorkerSessionTurnClaim): void {
      write((db) => {
        const pending = assertPendingClaim(db, claim);
        if (pending.gateway_instance_id !== instanceId) {
          throw new Error(
            `Worker workspace result belongs to another gateway for ${claim.sessionId}`,
          );
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_workspace_pending_results")
            .set({ recovery_requested_at_ms: now() })
            .where("session_id", "=", claim.sessionId)
            .where("gateway_instance_id", "=", instanceId),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker workspace result changed for ${claim.sessionId}`);
        }
      });
    },

    abandonWorkspaceResult(pending: WorkerWorkspacePendingResult): void {
      write((db) => {
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .deleteFrom("worker_workspace_pending_results")
            .where("session_id", "=", pending.sessionId)
            .where("environment_id", "=", pending.environmentId)
            .where("owner_epoch", "=", pending.ownerEpoch)
            .where("placement_generation", "=", pending.placementGeneration)
            .where("claim_id", "=", pending.claimId)
            .where("run_id", "=", pending.runId),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker workspace result changed for ${pending.sessionId}`);
        }
      });
    },
  };
}
