import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceResultConflict,
} from "./workspace-conflicts.js";
import {
  deleteStagedWorkerWorkspaceResult,
  isWorkerWorkspaceResultCleanupRef,
  moveStagedWorkerWorkspaceResultToCleanup,
} from "./workspace-result-staging.js";

type WorkspaceResultFinalizationStore = Pick<
  WorkerSessionPlacementStore,
  "completeWorkspaceResultAndReleaseTurn" | "recordWorkspaceResultConflict"
>;

type WorkspaceResultConflictReport = Required<WorkerWorkspaceResultConflict> | { cleared: true };

export async function finalizeWorkspaceResultConflicts(params: {
  placements: WorkspaceResultFinalizationStore;
  turnClaim: WorkerSessionTurnClaim;
  conflictPaths: readonly string[];
  priorConflict: WorkerWorkspaceResultConflict | undefined;
  stagedResultRef: string | null | undefined;
  retainPriorConflict?: boolean;
  report: (report: WorkspaceResultConflictReport) => Promise<void>;
  root: string;
}): Promise<{
  conflict: Required<WorkerWorkspaceResultConflict> | undefined;
  conflictRetained: boolean;
}> {
  const retainedPriorConflict =
    params.retainPriorConflict && params.conflictPaths.length === 0
      ? params.priorConflict
      : undefined;
  const supersededConflict =
    params.priorConflict &&
    !retainedPriorConflict &&
    (params.conflictPaths.length === 0 ||
      params.priorConflict.stagedResultRef !== params.stagedResultRef)
      ? params.priorConflict
      : undefined;
  if (supersededConflict && supersededConflict.stagedResultRef !== params.stagedResultRef) {
    // Delete the inspectable result before replacing its last durable pointer.
    await deleteStagedWorkerWorkspaceResult({
      root: params.root,
      stagedResultRef: supersededConflict.stagedResultRef,
    });
  }

  let conflict: Required<WorkerWorkspaceResultConflict> | undefined;
  if (params.conflictPaths.length > 0) {
    if (!params.stagedResultRef) {
      throw new Error("Cloud workspace conflict has no staged result reference");
    }
    conflict = projectWorkspaceResultConflict(params.conflictPaths, params.stagedResultRef);
    params.placements.recordWorkspaceResultConflict(params.turnClaim, conflict);
    await params.report(conflict);
  } else if (retainedPriorConflict) {
    params.placements.recordWorkspaceResultConflict(params.turnClaim, retainedPriorConflict);
  } else if (supersededConflict) {
    params.placements.recordWorkspaceResultConflict(params.turnClaim, undefined);
    await params.report({ cleared: true });
  }

  return { conflict, conflictRetained: conflict !== undefined };
}

type StagedWorkspaceResultSettlement = {
  placements: WorkspaceResultFinalizationStore;
  turnClaim: WorkerSessionTurnClaim;
  root: string;
  stagedResultRef: string | null | undefined;
  conflictRetained: boolean;
  reclaim: boolean;
  beforeComplete: () => Promise<void>;
  afterComplete?: (completed: WorkerSessionPlacementRecord) => Promise<void>;
  validateCompleted?: (completed: WorkerSessionPlacementRecord) => void;
};

export function settleStagedWorkspaceResult(
  params: StagedWorkspaceResultSettlement & { reclaim: true },
): Promise<Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>>;
export function settleStagedWorkspaceResult(
  params: StagedWorkspaceResultSettlement & { reclaim: false },
): Promise<WorkerSessionPlacementRecord>;
export function settleStagedWorkspaceResult(
  params: StagedWorkspaceResultSettlement,
): Promise<WorkerSessionPlacementRecord>;
export async function settleStagedWorkspaceResult(
  params: StagedWorkspaceResultSettlement,
): Promise<WorkerSessionPlacementRecord> {
  const cleanupRef =
    params.stagedResultRef && !params.conflictRetained
      ? isWorkerWorkspaceResultCleanupRef(params.stagedResultRef)
        ? params.stagedResultRef
        : await moveStagedWorkerWorkspaceResultToCleanup({
            root: params.root,
            stagedResultRef: params.stagedResultRef,
          })
      : undefined;
  await params.beforeComplete();
  const completed = params.reclaim
    ? params.placements.completeWorkspaceResultAndReleaseTurn(params.turnClaim, { reclaim: true })
    : params.placements.completeWorkspaceResultAndReleaseTurn(params.turnClaim);
  params.validateCompleted?.(completed);
  await params.afterComplete?.(completed);
  if (cleanupRef) {
    // Cleanup refs remain discoverable after the SQLite fence disappears.
    await deleteStagedWorkerWorkspaceResult({
      root: params.root,
      stagedResultRef: cleanupRef,
    }).catch(() => undefined);
  }
  return completed;
}
