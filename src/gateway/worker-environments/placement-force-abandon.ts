import type { WorkerDispatchPlacementStore } from "./placement-dispatch-failure.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  deleteStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

async function tryResolveWorkspacePath(
  resolveWorkspacePath: (placement: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<string>,
  placement: { sessionId: string; sessionKey: string; agentId: string },
): Promise<string | undefined> {
  try {
    return await resolveWorkspacePath(placement);
  } catch {
    // Forced teardown is the last-resort state owner. If the session/worktree is
    // already gone, skip local repair/ref cleanup and still release the claim.
    return undefined;
  }
}

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
      const root = await tryResolveWorkspacePath(params.resolveWorkspacePath, placement);
      if (root) {
        await recoverWorkerWorkspaceReconciliation({ root, journal });
      }
      placements.abortWorkspaceReconciliation(owner);
    }
  }
  for (const pending of placements.listPendingWorkspaceResults()) {
    if (pending.environmentId === environmentId) {
      const placement = placements.get(pending.sessionId);
      if (!placement) {
        if (pending.stagedResultRef) {
          throw new Error(
            `Forced teardown found a staged result without a placement: ${pending.sessionId}`,
          );
        }
      } else {
        const root = await tryResolveWorkspacePath(params.resolveWorkspacePath, placement);
        if (root) {
          const finalRef = pending.stagedResultRef ?? workerWorkspaceResultRef(pending.claimId);
          const refs = [finalRef, preparedWorkerWorkspaceResultRef(finalRef)];
          for (const stagedResultRef of refs) {
            if (await hasWorkerWorkspaceResultRef({ root, stagedResultRef })) {
              await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef });
            }
          }
        }
      }
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
