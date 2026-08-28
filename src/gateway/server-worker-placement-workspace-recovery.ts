import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./worker-environments/placement-force-abandon.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { recoverWorkerWorkspaceReconciliation } from "./worker-environments/workspace-reconcile.js";

const workerPlacementLog = createSubsystemLogger("gateway/worker-placement");

export async function recoverGatewayWorkerPlacementWorkspaces(params: {
  placements: WorkerSessionPlacementStore;
  resolveWorkspacePath: (identity: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<string>;
}): Promise<void> {
  const orphanedJournals = params.placements.pruneOrphanedWorkspaceReconciliations({
    retainFailedOwner: (recoveryError) => recoveryError.startsWith(FORCED_WORKER_ABANDONMENT_ERROR),
  });
  for (const owner of orphanedJournals) {
    workerPlacementLog.warn(`discarded orphaned cloud workspace journal for ${owner.sessionId}`);
  }
  const pendingBySession = new Map(
    params.placements
      .listPendingWorkspaceResults()
      .map((pending) => [pending.sessionId, pending] as const),
  );
  for (const owner of params.placements.listWorkspaceReconciliationOwners()) {
    try {
      const placement = params.placements.get(owner.sessionId);
      const pending = pendingBySession.get(owner.sessionId);
      const ownsCurrentGeneration = placement?.generation === owner.placementGeneration;
      const ownsDrainedPendingGeneration =
        placement?.state === "draining" &&
        placement.generation === owner.placementGeneration + 1 &&
        pending?.environmentId === owner.environmentId &&
        pending.ownerEpoch === owner.ownerEpoch &&
        pending.placementGeneration === owner.placementGeneration;
      if (
        (placement?.state !== "active" && placement?.state !== "draining") ||
        placement.environmentId !== owner.environmentId ||
        placement.activeOwnerEpoch !== owner.ownerEpoch ||
        (!ownsCurrentGeneration && !ownsDrainedPendingGeneration)
      ) {
        throw new Error(`Cloud workspace journal has no matching owner: ${owner.sessionId}`);
      }
      const localPath = await params.resolveWorkspacePath({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
      });
      const journal = params.placements.loadWorkspaceReconciliation(owner);
      if (!journal) {
        continue;
      }
      // Recover before placement/environment reconciliation can reclaim the
      // owner; otherwise a crashed partial apply loses its final repair path.
      await recoverWorkerWorkspaceReconciliation({ root: localPath, journal });
      params.placements.abortWorkspaceReconciliation(owner);
    } catch (error) {
      // A local edit can intentionally block rollback. Leave that journal
      // retryable for this session without withholding every cloud worker.
      workerPlacementLog.error(
        `cloud workspace recovery deferred for ${owner.sessionId}: ${formatErrorMessage(error)}`,
      );
    }
  }
}
