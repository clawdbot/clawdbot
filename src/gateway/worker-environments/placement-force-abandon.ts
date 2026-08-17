import type { WorkerDispatchPlacementStore } from "./placement-dispatch-failure.js";
import {
  isCurrentPlacementTurnClaim,
  placementTurnOwner,
  placementWorkspaceResultClaim,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  cleanupWorkerWorkspaceResultRef,
  deleteStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const FORCED_WORKER_ABANDONMENT_ERROR = "Cloud worker result abandoned by forced operator teardown";

export class WorkerForcedAbandonmentBlockedError extends Error {
  constructor(environmentId: string) {
    super(
      `Workspace recovery still owns ${environmentId}; explicit forced abandonment is required`,
    );
  }
}

async function tryResolveWorkspacePath(
  resolveWorkspacePath: (placement: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<string>,
  placement: { sessionId: string; sessionKey: string; agentId: string },
  onCleanupError?: (error: unknown) => void,
): Promise<string | undefined> {
  try {
    return await resolveWorkspacePath(placement);
  } catch (error) {
    // Forced teardown is the last-resort state owner. If the session/worktree is
    // already gone, skip local repair/ref cleanup and still release the claim.
    reportCleanupError(onCleanupError, error);
    return undefined;
  }
}

function reportCleanupError(
  onCleanupError: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    onCleanupError?.(error);
  } catch {
    // Cleanup reporting cannot overturn a committed forced abandonment.
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
  onCleanupError?: (error: unknown) => void;
  authorizeAbandonment?: () => boolean;
  reportWorkspaceResultConflict: (placement: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    cleared: true;
    stagedResultRef: string;
  }) => Promise<void>;
}): Promise<void> {
  const { environmentId, placements } = params;
  const assertAbandonmentAllowed = (): void => {
    if (params.authorizeAbandonment && !params.authorizeAbandonment()) {
      throw new WorkerForcedAbandonmentBlockedError(environmentId);
    }
  };
  assertAbandonmentAllowed();
  const recoveryError = FORCED_WORKER_ABANDONMENT_ERROR;
  const pendingResults = placements
    .listPendingWorkspaceResults()
    .filter((pending) => pending.environmentId === environmentId);
  const pendingResultsBySession = new Map(
    pendingResults.map((pending) => [pending.sessionId, pending] as const),
  );
  const teardownFences = placements.listEnvironmentTeardownFences(environmentId);
  const journalOwners = params.placements
    .listWorkspaceReconciliationOwners()
    .filter((owner) => owner.environmentId === environmentId);
  const journalCleanups: Array<{
    owner: (typeof journalOwners)[number];
    placement: { sessionId: string; sessionKey: string; agentId: string };
    journal: NonNullable<ReturnType<typeof placements.loadWorkspaceReconciliation>>;
  }> = [];
  const retainedJournalSessions = new Set<string>();
  for (const owner of journalOwners) {
    const placement = placements.get(owner.sessionId);
    const fence = teardownFences.find(
      (candidate) =>
        candidate.kind === "workspace-reconciliation" &&
        candidate.sessionId === owner.sessionId &&
        candidate.environmentId === owner.environmentId &&
        candidate.ownerEpoch === owner.ownerEpoch &&
        candidate.placementGeneration === owner.placementGeneration,
    );
    const pending = pendingResultsBySession.get(owner.sessionId);
    const pendingFence = pending
      ? teardownFences.find(
          (candidate) =>
            candidate.kind === "pending-workspace-result" &&
            candidate.sessionId === pending.sessionId &&
            candidate.environmentId === pending.environmentId &&
            candidate.ownerEpoch === pending.ownerEpoch &&
            candidate.placementGeneration === pending.placementGeneration,
        )
      : undefined;
    if (placement && (fence || pendingFence)) {
      placements.retainWorkspaceReconciliationForForcedAbandonment(owner);
      try {
        const journal = placements.loadWorkspaceReconciliation(
          owner,
          fence?.ownerState === "retained-failed" || pendingFence?.ownerState === "retained-failed"
            ? { allowFailedOwner: true }
            : undefined,
        );
        if (journal) {
          journalCleanups.push({ owner, placement, journal });
        }
      } catch (error) {
        reportCleanupError(params.onCleanupError, error);
        retainedJournalSessions.add(owner.sessionId);
      }
    }
  }
  const stagedResultCleanups: Array<{
    placement: { sessionId: string; sessionKey: string; agentId: string };
    finalRef: string;
    refs: string[];
  }> = [];
  for (const pending of pendingResults) {
    const placement = placements.get(pending.sessionId);
    const fence = teardownFences.find(
      (candidate) =>
        candidate.kind === "pending-workspace-result" &&
        candidate.sessionId === pending.sessionId &&
        candidate.environmentId === pending.environmentId &&
        candidate.ownerEpoch === pending.ownerEpoch &&
        candidate.placementGeneration === pending.placementGeneration,
    );
    if (placement && fence) {
      const finalRef = pending.stagedResultRef ?? workerWorkspaceResultRef(pending.claimId);
      stagedResultCleanups.push({
        placement,
        finalRef,
        refs: [
          cleanupWorkerWorkspaceResultRef(finalRef),
          preparedWorkerWorkspaceResultRef(finalRef),
          finalRef,
        ],
      });
    }
    if (fence) {
      if (fence.ownerState === "current") {
        const claim = placementWorkspaceResultClaim(placement, pending);
        if (!claim || !placements.validateWorkspaceResultClaim(claim)) {
          throw new Error(`Pending workspace result lost its claim for ${pending.sessionId}`);
        }
        if (placement && isCurrentPlacementTurnClaim(placement, claim)) {
          await placements.closeWorkerTurnToolState(claim);
        }
      }
      assertAbandonmentAllowed();
      placements.forceAbandonPendingWorkspaceResult({
        pending,
        recoveryError,
      });
    } else {
      placements.abandonWorkspaceResult(pending);
    }
  }
  for (const placement of placements.listForReconcile()) {
    if (placement.environmentId !== environmentId) {
      continue;
    }
    let current = placements.get(placement.sessionId);
    if (current?.state === "active") {
      assertAbandonmentAllowed();
      current = placements.startDrain({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
      });
    }
    if (current?.state === "draining") {
      if (current.turnClaim) {
        const claim = {
          sessionId: current.sessionId,
          claimId: current.turnClaim.claimId,
          runId: current.turnClaim.runId,
          placementGeneration: current.turnClaim.generation,
          owner: placementTurnOwner(current),
        } satisfies WorkerSessionTurnClaim;
        await placements.closeWorkerTurnToolState(claim);
        assertAbandonmentAllowed();
        const abandoned = placements.forceAbandonWorkerTurn({
          claim,
          expectedGeneration: current.generation,
          recoveryError,
        });
        if (abandoned.record.state === "failed") {
          const finalRef = abandoned.stagedResultRef ?? workerWorkspaceResultRef(claim.claimId);
          stagedResultCleanups.push({
            placement: abandoned.record,
            finalRef,
            refs: [
              cleanupWorkerWorkspaceResultRef(finalRef),
              preparedWorkerWorkspaceResultRef(finalRef),
              finalRef,
            ],
          });
        }
        current = abandoned.record;
      } else {
        assertAbandonmentAllowed();
        current = placements.startReconcile({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
      }
    }
    if (current && current.state !== "failed") {
      assertAbandonmentAllowed();
      placements.fail({
        sessionId: current.sessionId,
        expectedGeneration: current.generation,
        recoveryError,
      });
    }
  }

  // The durable fence is now closed. Filesystem rollback and ref cleanup are
  // useful hygiene, but a changed or missing workspace must not revive it.
  for (const cleanup of journalCleanups) {
    if (cleanup.journal.appliedManifestRef) {
      continue;
    }
    try {
      const root = await params.resolveWorkspacePath(cleanup.placement);
      await recoverWorkerWorkspaceReconciliation({ root, journal: cleanup.journal });
    } catch (error) {
      reportCleanupError(params.onCleanupError, error);
      retainedJournalSessions.add(cleanup.owner.sessionId);
    }
  }
  // Placement failure is durable before journal removal. A crash during the
  // best-effort rollback therefore leaves a fenced placement and retriable journal.
  for (const owner of journalOwners) {
    if (retainedJournalSessions.has(owner.sessionId)) {
      continue;
    }
    placements.abortWorkspaceReconciliation(owner, { force: true });
  }
  for (const cleanup of stagedResultCleanups) {
    try {
      const root = await tryResolveWorkspacePath(
        params.resolveWorkspacePath,
        cleanup.placement,
        params.onCleanupError,
      );
      if (!root) {
        continue;
      }
      for (const stagedResultRef of cleanup.refs) {
        if (await hasWorkerWorkspaceResultRef({ root, stagedResultRef })) {
          await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef });
        }
      }
    } catch (error) {
      reportCleanupError(params.onCleanupError, error);
      continue;
    }
    try {
      await params.reportWorkspaceResultConflict({
        sessionId: cleanup.placement.sessionId,
        sessionKey: cleanup.placement.sessionKey,
        agentId: cleanup.placement.agentId,
        cleared: true,
        stagedResultRef: cleanup.finalRef,
      });
    } catch (error) {
      reportCleanupError(params.onCleanupError, error);
    }
    placements.retireWorkspaceResultConflict({
      sessionId: cleanup.placement.sessionId,
      stagedResultRef: cleanup.finalRef,
    });
  }
}
