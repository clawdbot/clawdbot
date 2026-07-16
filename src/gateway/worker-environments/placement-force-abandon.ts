import type { WorkerDispatchPlacementStore } from "./placement-dispatch-failure.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";

export async function forceAbandonWorkerEnvironment(params: {
  placements: WorkerDispatchPlacementStore;
  environmentId: string;
  resolveWorkspacePath: (placement: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<string>;
}): Promise<void> {
  const { environmentId, placements } = params;
  const recoveryError = "Cloud worker result abandoned by forced operator teardown";
  for (const owner of placements.listWorkspaceReconciliationOwners()) {
    if (owner.environmentId !== environmentId) {
      continue;
    }
    const placement = placements.get(owner.sessionId);
    if (
      (placement?.state !== "active" && placement?.state !== "draining") ||
      placement.environmentId !== owner.environmentId ||
      placement.activeOwnerEpoch !== owner.ownerEpoch ||
      placement.generation !== owner.placementGeneration
    ) {
      throw new Error(`Forced teardown found a stale workspace journal: ${owner.sessionId}`);
    }
    const journal = placements.loadWorkspaceReconciliation(owner);
    if (journal) {
      const root = await params.resolveWorkspacePath(placement);
      await recoverWorkerWorkspaceReconciliation({ root, journal });
      placements.abortWorkspaceReconciliation(owner);
    }
  }
  for (const pending of placements.listPendingWorkspaceResults()) {
    if (pending.environmentId === environmentId) {
      placements.abandonWorkspaceResult(pending);
    }
  }
  for (const placement of placements.listForReconcile()) {
    if (placement.environmentId !== environmentId) {
      continue;
    }
    let current = placements.get(placement.sessionId);
    if (current?.state === "active") {
      current = placements.startDrain({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
      });
    }
    if (current?.state === "draining") {
      current = placements.startReconcile({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
      });
    }
    if (current && current.state !== "failed") {
      placements.fail({
        sessionId: current.sessionId,
        expectedGeneration: current.generation,
        recoveryError,
      });
    }
  }
}
