import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  placementTurnOwner,
  required,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { getRequired, query, transitionValues } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import {
  assertNoRunningWorkerSessionToolOperations,
  clearWorkerTurnToolState,
} from "./placement-session-tool-operations.js";
import { signalWorkerTurnClaimClosed } from "./placement-turn-claims.js";
import {
  isCurrentWorkerWorkspacePendingResultOwner,
  type WorkerWorkspacePendingResult,
} from "./placement-workspace-result.js";
import { boundedWorkerError } from "./worker-error.js";

export function createPlacementPendingFailureOps(runtime: PlacementStoreRuntime) {
  const { now, path, write } = runtime;
  return {
    failWorkspaceResultAndReleaseTurn(
      pending: WorkerWorkspacePendingResult,
      error: unknown,
    ): WorkerSessionPlacementRecord {
      const sessionId = required(pending.sessionId, "session id");
      const recoveryError = boundedWorkerError(error);
      const outcome = write((db) => {
        const current = getRequired(db, sessionId);
        if (!isCurrentWorkerWorkspacePendingResultOwner(current, pending)) {
          throw new Error(`Session ${sessionId} workspace result owner changed before failure`);
        }
        const persisted = current.turnClaim;
        const releasedClaim: WorkerSessionTurnClaim | null = persisted
          ? {
              sessionId,
              claimId: persisted.claimId,
              runId: persisted.runId,
              placementGeneration: persisted.generation,
              owner: placementTurnOwner(current),
            }
          : null;
        const pendingQuery =
          getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_pending_results">>(db);
        const exactPending = executeSqliteQuerySync(
          db,
          pendingQuery
            .selectFrom("worker_workspace_pending_results")
            .select("session_id")
            .where("session_id", "=", sessionId)
            .where("environment_id", "=", pending.environmentId)
            .where("owner_epoch", "=", pending.ownerEpoch)
            .where("placement_generation", "=", pending.placementGeneration)
            .where("claim_id", "=", pending.claimId)
            .where("run_id", "=", pending.runId),
        ).rows[0];
        if (!exactPending) {
          throw new Error(`Session ${sessionId} workspace result changed before failure`);
        }
        const terminalAtMs = now();
        let transitioning: WorkerSessionPlacementRecord = current;
        if (transitioning.state === "active") {
          const values = transitionValues(transitioning, "draining", {}, terminalAtMs);
          if (persisted) {
            values.turn_claim_owner = persisted.owner;
            values.turn_claim_id = persisted.claimId;
            values.turn_claim_run_id = persisted.runId;
            values.turn_claim_generation = persisted.generation;
            values.turn_claim_owner_epoch = persisted.ownerEpoch;
          }
          const drained = executeSqliteQuerySync(
            db,
            query(db)
              .updateTable("worker_session_placements")
              .set(values)
              .where("session_id", "=", sessionId)
              .where("state", "=", "active")
              .where("transition_generation", "=", transitioning.generation),
          );
          if (drained.numAffectedRows !== 1n) {
            throw new Error(`Session ${sessionId} workspace result changed during drain`);
          }
          transitioning = getRequired(db, sessionId);
        }
        if (transitioning.state !== "draining") {
          throw new Error(`Session ${sessionId} workspace result did not reach draining`);
        }
        if (persisted) {
          assertNoRunningWorkerSessionToolOperations(db, {
            sessionId,
            claimId: persisted.claimId,
          });
          clearWorkerTurnToolState(db, { sessionId, claimId: persisted.claimId });
        }
        const reconcilingValues = transitionValues(transitioning, "reconciling", {}, terminalAtMs);
        const reconciled = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set(reconcilingValues)
            .where("session_id", "=", sessionId)
            .where("state", "=", "draining")
            .where("transition_generation", "=", transitioning.generation),
        );
        if (reconciled.numAffectedRows !== 1n) {
          throw new Error(`Session ${sessionId} workspace result changed during reconcile`);
        }
        transitioning = getRequired(db, sessionId);
        const failedValues = transitionValues(
          transitioning,
          "failed",
          { recoveryError, terminalReason: recoveryError },
          terminalAtMs,
        );
        const failed = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set(failedValues)
            .where("session_id", "=", sessionId)
            .where("state", "=", "reconciling")
            .where("transition_generation", "=", transitioning.generation)
            .where("turn_claim_owner", "is", null),
        );
        if (failed.numAffectedRows !== 1n) {
          throw new Error(`Session ${sessionId} workspace result changed during failure`);
        }
        const removed = executeSqliteQuerySync(
          db,
          pendingQuery
            .deleteFrom("worker_workspace_pending_results")
            .where("session_id", "=", sessionId)
            .where("environment_id", "=", pending.environmentId)
            .where("owner_epoch", "=", pending.ownerEpoch)
            .where("placement_generation", "=", pending.placementGeneration)
            .where("claim_id", "=", pending.claimId)
            .where("run_id", "=", pending.runId),
        );
        if (removed.numAffectedRows !== 1n) {
          throw new Error(`Session ${sessionId} workspace result changed during failure`);
        }
        return {
          record: getRequired(db, sessionId),
          releasedClaim,
        };
      });
      if (outcome.releasedClaim) {
        signalWorkerTurnClaimClosed(path, outcome.releasedClaim);
      }
      return outcome.record;
    },
  };
}
