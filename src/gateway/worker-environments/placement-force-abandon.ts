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
}): Promise<void> {
  const { environmentId, placements } = params;
  const recoveryError = "Cloud worker result abandoned by forced operator teardown";
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
    const isCurrentOwner =
      (placement?.state === "active" || placement?.state === "draining") &&
      placement.generation === owner.placementGeneration;
    const isForceFailedOwner =
      placement?.state === "failed" &&
      placement.recoveryError.startsWith(recoveryError) &&
      placement.generation > owner.placementGeneration;
    if (
      placement &&
      (isCurrentOwner || isForceFailedOwner) &&
      placement.environmentId === owner.environmentId &&
      placement.activeOwnerEpoch === owner.ownerEpoch
    ) {
      try {
        const journal = placements.loadWorkspaceReconciliation(
          owner,
          isForceFailedOwner ? { allowFailedOwner: true } : undefined,
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
    refs: string[];
  }> = [];
  for (const pending of placements.listPendingWorkspaceResults()) {
    if (pending.environmentId === environmentId) {
      const placement = placements.get(pending.sessionId);
      if (
        (placement?.state === "active" || placement?.state === "draining") &&
        placement.environmentId === pending.environmentId &&
        placement.activeOwnerEpoch === pending.ownerEpoch &&
        placement.generation === pending.placementGeneration
      ) {
        const finalRef = pending.stagedResultRef ?? workerWorkspaceResultRef(pending.claimId);
        stagedResultCleanups.push({
          placement,
          refs: [finalRef, preparedWorkerWorkspaceResultRef(finalRef)],
        });
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
    }
  }
}
