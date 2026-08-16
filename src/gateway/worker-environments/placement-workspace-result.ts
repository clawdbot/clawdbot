import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  isCurrentPlacementTurnClaim,
  placementWorkspaceResultClaim,
  resolvePlacementTurnEnvironment,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { getRequired, query as placementQuery, transitionValues } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import {
  assertNoRunningWorkerSessionToolOperations,
  clearWorkerTurnToolState,
} from "./placement-session-tool-operations.js";
import { isRetainedFailedWorkspaceResultOwner } from "./placement-teardown-fence.js";
import { clearWorkerWorkspaceReconciliation } from "./placement-workspace-journal.js";

type WorkspaceResultDatabase = Pick<
  StateDatabase,
  "worker_session_placements" | "worker_workspace_pending_results"
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
};

function matchesWorkspaceResultClaim(
  placement: WorkerSessionPlacementRecord,
  row: StateDatabase["worker_workspace_pending_results"],
  claim: WorkerSessionTurnClaim,
): boolean {
  const currentClaim = placementWorkspaceResultClaim(placement, {
    sessionId: row.session_id,
    environmentId: row.environment_id,
    ownerEpoch: row.owner_epoch,
    placementGeneration: row.placement_generation,
    claimId: row.claim_id,
    runId: row.run_id,
  });
  return Boolean(
    currentClaim &&
    currentClaim.sessionId === claim.sessionId &&
    currentClaim.claimId === claim.claimId &&
    currentClaim.runId === claim.runId &&
    currentClaim.placementGeneration === claim.placementGeneration &&
    currentClaim.owner.kind === claim.owner.kind &&
    currentClaim.owner.environmentId === claim.owner.environmentId &&
    currentClaim.owner.ownerEpoch === claim.owner.ownerEpoch,
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

type WorkerWorkspaceResultOwnerIdentity = Pick<
  WorkerWorkspacePendingResult,
  "environmentId" | "ownerEpoch" | "placementGeneration"
>;

export function hasMatchingRetainedFailedWorkspaceResultOwner(
  db: DatabaseSync,
  placement: WorkerSessionPlacementRecord | undefined,
  owner: WorkerWorkspaceResultOwnerIdentity & { sessionId: string },
): boolean {
  const pending = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .select(["environment_id", "owner_epoch", "placement_generation"])
      .where("session_id", "=", owner.sessionId)
      .where("environment_id", "=", owner.environmentId)
      .where("owner_epoch", "=", owner.ownerEpoch),
  ).rows[0];
  return Boolean(
    pending &&
    (owner.placementGeneration === pending.placement_generation ||
      owner.placementGeneration === pending.placement_generation + 1) &&
    isRetainedFailedWorkspaceResultOwner(placement, {
      environmentId: pending.environment_id,
      ownerEpoch: pending.owner_epoch,
      placementGeneration: pending.placement_generation,
    }),
  );
}

export function clearWorkerWorkspacePendingResult(db: DatabaseSync, sessionId: string): void {
  executeSqliteQuerySync(
    db,
    query(db).deleteFrom("worker_workspace_pending_results").where("session_id", "=", sessionId),
  );
}

function deleteWorkerWorkspacePendingResult(
  db: DatabaseSync,
  pending: WorkerWorkspacePendingResult,
): void {
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

export function createPlacementWorkspaceResultOps(
  runtime: PlacementStoreRuntime,
  deps: {
    signalTurnClaimClosed: (path: string, claim: WorkerSessionTurnClaim) => void;
  },
) {
  const { instanceId, now, path, read, write } = runtime;
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
          .orderBy("session_id"),
      ).rows.map((row) => ({
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
      }));
    },

    markWorkspaceResultPending(claim: WorkerSessionTurnClaim): void {
      write((db) => {
        insertWorkerWorkspacePendingResult(db, claim, now(), instanceId);
      });
    },

    recordStagedWorkspaceResult(claim: WorkerSessionTurnClaim, stagedResultRef: string): void {
      if (!/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(stagedResultRef)) {
        throw new Error("Worker workspace staged result reference is invalid");
      }
      write((db) => {
        const pending = assertPendingClaim(db, claim);
        if (pending.workspace_accepted_at_ms !== null) {
          throw new Error(`Cannot restage accepted worker workspace result for ${claim.sessionId}`);
        }
        if (pending.staged_result_ref && pending.staged_result_ref !== stagedResultRef) {
          throw new Error(`Worker workspace result ref changed for ${claim.sessionId}`);
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_workspace_pending_results")
            .set({ staged_result_ref: stagedResultRef })
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

    forceAbandonPendingWorkspaceResult(input: {
      pending: WorkerWorkspacePendingResult;
      recoveryError: string;
    }): WorkerSessionPlacementRecord {
      const { pending } = input;
      const recoveryError = input.recoveryError.trim();
      if (!recoveryError) {
        throw new Error("Forced worker workspace abandonment error is required");
      }
      const outcome = write((db) => {
        const current = getRequired(db, pending.sessionId);
        const currentClaim = placementWorkspaceResultClaim(current, pending);
        const liveClaim =
          currentClaim && isCurrentPlacementTurnClaim(current, currentClaim)
            ? currentClaim
            : undefined;
        const isCurrentOwner = Boolean(currentClaim);
        const isRetainedFailedOwner = isRetainedFailedWorkspaceResultOwner(current, pending);
        if (!isCurrentOwner && !isRetainedFailedOwner) {
          throw new Error(
            `Cannot force-abandon stale worker workspace result for ${pending.sessionId}`,
          );
        }

        const updatedAtMs = now();
        let update;
        if (current.state === "failed") {
          update = placementQuery(db)
            .updateTable("worker_session_placements")
            .set({ recovery_error: recoveryError, updated_at_ms: updatedAtMs })
            .where("session_id", "=", pending.sessionId)
            .where("state", "=", "failed")
            .where("transition_generation", "=", current.generation)
            .where("environment_id", "=", pending.environmentId)
            .where("active_owner_epoch", "=", pending.ownerEpoch)
            .where("turn_claim_owner", "is", null);
        } else {
          if (!currentClaim) {
            throw new Error(`Pending worker result lost its claim for ${pending.sessionId}`);
          }
          const placementUpdate = placementQuery(db)
            .updateTable("worker_session_placements")
            .set(transitionValues(current, "failed", { recoveryError }, updatedAtMs))
            .where("session_id", "=", pending.sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .where("environment_id", "=", pending.environmentId)
            .where("active_owner_epoch", "=", pending.ownerEpoch);
          update =
            liveClaim?.owner.kind === "worker"
              ? placementUpdate
                  .where("turn_claim_owner", "=", "worker")
                  .where("turn_claim_id", "=", pending.claimId)
                  .where("turn_claim_run_id", "=", pending.runId)
                  .where("turn_claim_generation", "=", pending.placementGeneration)
                  .where("turn_claim_owner_epoch", "=", pending.ownerEpoch)
              : liveClaim
                ? placementUpdate
                    .where("turn_claim_owner", "=", "local")
                    .where("turn_claim_id", "=", pending.claimId)
                    .where("turn_claim_run_id", "=", pending.runId)
                    .where("turn_claim_generation", "=", pending.placementGeneration)
                    .where("turn_claim_owner_epoch", "is", null)
                : placementUpdate
                    .where("turn_claim_owner", "is", null)
                    .where("turn_claim_id", "is", null)
                    .where("turn_claim_run_id", "is", null)
                    .where("turn_claim_generation", "is", null)
                    .where("turn_claim_owner_epoch", "is", null);
        }
        const result = executeSqliteQuerySync(db, update);
        if (result.numAffectedRows !== 1n) {
          throw new Error(
            `Pending worker result owner changed during forced abandonment for ${pending.sessionId}`,
          );
        }
        deleteWorkerWorkspacePendingResult(db, pending);
        return {
          record: getRequired(db, pending.sessionId),
          releasedClaim: isCurrentOwner ? liveClaim : undefined,
        };
      });
      if (outcome.releasedClaim) {
        deps.signalTurnClaimClosed(path, outcome.releasedClaim);
      }
      return outcome.record;
    },

    forceAbandonWorkerTurn(input: {
      claim: WorkerSessionTurnClaim;
      expectedGeneration: number;
      recoveryError: string;
    }): { record: WorkerSessionPlacementRecord; stagedResultRef?: string } {
      const { claim } = input;
      const recoveryError = input.recoveryError.trim();
      if (!recoveryError) {
        throw new Error("Forced worker turn abandonment requires a turn claim and error");
      }
      const outcome = write((db) => {
        const current = getRequired(db, claim.sessionId);
        const environment = resolvePlacementTurnEnvironment(current, claim);
        if (
          current.state !== "draining" ||
          current.generation !== input.expectedGeneration ||
          !environment
        ) {
          throw new Error(`Cannot force-abandon stale worker turn for ${claim.sessionId}`);
        }
        assertNoRunningWorkerSessionToolOperations(db, {
          sessionId: claim.sessionId,
          claimId: claim.claimId,
        });
        const pending = executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_workspace_pending_results")
            .select([
              "environment_id",
              "owner_epoch",
              "placement_generation",
              "claim_id",
              "run_id",
              "staged_result_ref",
            ])
            .where("session_id", "=", claim.sessionId),
        ).rows[0];
        if (
          pending &&
          (pending.environment_id !== environment.environmentId ||
            pending.owner_epoch !== environment.ownerEpoch ||
            pending.placement_generation !== claim.placementGeneration ||
            pending.claim_id !== claim.claimId ||
            pending.run_id !== claim.runId)
        ) {
          throw new Error(`Cannot force-abandon mismatched worker result for ${claim.sessionId}`);
        }
        clearWorkerTurnToolState(db, { sessionId: claim.sessionId, claimId: claim.claimId });
        if (pending) {
          clearWorkerWorkspacePendingResult(db, claim.sessionId);
        }
        const claimedUpdate = placementQuery(db)
          .updateTable("worker_session_placements")
          .set(
            pending
              ? transitionValues(current, "failed", { recoveryError }, now())
              : transitionValues(current, "reconciling", {}, now()),
          )
          .where("session_id", "=", claim.sessionId)
          .where("state", "=", "draining")
          .where("transition_generation", "=", current.generation)
          .where("environment_id", "=", environment.environmentId)
          .where("active_owner_epoch", "=", environment.ownerEpoch)
          .where("turn_claim_owner", "=", claim.owner.kind)
          .where("turn_claim_id", "=", claim.claimId)
          .where("turn_claim_run_id", "=", claim.runId)
          .where("turn_claim_generation", "=", claim.placementGeneration);
        const update =
          claim.owner.kind === "worker"
            ? claimedUpdate.where("turn_claim_owner_epoch", "=", environment.ownerEpoch)
            : claimedUpdate.where("turn_claim_owner_epoch", "is", null);
        const result = executeSqliteQuerySync(db, update);
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker turn owner changed during abandonment for ${claim.sessionId}`);
        }
        return {
          record: getRequired(db, claim.sessionId),
          stagedResultRef: pending?.staged_result_ref ?? undefined,
        };
      });
      deps.signalTurnClaimClosed(path, claim);
      return outcome;
    },

    abandonWorkspaceResult(pending: WorkerWorkspacePendingResult): void {
      write((db) => {
        deleteWorkerWorkspacePendingResult(db, pending);
      });
    },
  };
}
