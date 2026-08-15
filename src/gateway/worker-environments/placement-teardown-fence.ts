import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionTurnClaim,
  WorkerTerminalRecovery,
} from "./placement-record.js";
import { find as findPlacement } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";

type TeardownFenceDatabase = Pick<
  StateDatabase,
  | "worker_session_placements"
  | "worker_workspace_pending_results"
  | "worker_workspace_reconciliations"
>;

const query = (db: DatabaseSync) => getNodeSqliteKysely<TeardownFenceDatabase>(db);

type WorkerWorkspaceOwnerIdentity = {
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
};

type WorkerPendingResultOwnerIdentity = WorkerWorkspaceOwnerIdentity & {
  claimId: string;
  runId: string;
};

type WorkerEnvironmentTeardownFence = WorkerWorkspaceOwnerIdentity & {
  kind: "pending-workspace-result" | "workspace-reconciliation";
  ownerState: "current" | "retained-failed";
};

export function classifyPendingWorkspaceResultOwner(
  placement: WorkerSessionPlacementRecord | undefined,
  pending: WorkerPendingResultOwnerIdentity,
): WorkerEnvironmentTeardownFence["ownerState"] | undefined {
  const claim = placement?.turnClaim;
  const expectedGeneration =
    pending.placementGeneration + (placement?.state === "draining" ? 1 : 0);
  if (
    (placement?.state === "active" || placement?.state === "draining") &&
    placement.environmentId === pending.environmentId &&
    placement.activeOwnerEpoch === pending.ownerEpoch &&
    placement.generation === expectedGeneration &&
    claim?.owner === "worker" &&
    claim.claimId === pending.claimId &&
    claim.runId === pending.runId &&
    claim.generation === pending.placementGeneration &&
    claim.ownerEpoch === pending.ownerEpoch
  ) {
    return "current";
  }
  return placement?.state === "failed" &&
    placement.turnClaim === null &&
    placement.environmentId === pending.environmentId &&
    placement.activeOwnerEpoch === pending.ownerEpoch &&
    placement.generation > pending.placementGeneration
    ? "retained-failed"
    : undefined;
}

export function isRetainedFailedWorkspaceResultOwner(
  placement: WorkerSessionPlacementRecord | undefined,
  pending: Pick<
    WorkerWorkspaceOwnerIdentity,
    "environmentId" | "ownerEpoch" | "placementGeneration"
  >,
): placement is Extract<WorkerSessionPlacementRecord, { state: "failed" }> {
  return (
    placement?.state === "failed" &&
    placement.turnClaim === null &&
    placement.environmentId === pending.environmentId &&
    placement.activeOwnerEpoch === pending.ownerEpoch &&
    placement.generation > pending.placementGeneration
  );
}

export function classifyWorkspaceJournalOwner(
  placement: WorkerSessionPlacementRecord | undefined,
  owner: WorkerWorkspaceOwnerIdentity,
  retained: boolean,
): WorkerEnvironmentTeardownFence["ownerState"] | undefined {
  if (
    (placement?.state === "active" || placement?.state === "draining") &&
    placement.environmentId === owner.environmentId &&
    placement.activeOwnerEpoch === owner.ownerEpoch &&
    placement.generation === owner.placementGeneration
  ) {
    return "current";
  }
  return retained &&
    placement?.state === "failed" &&
    placement.environmentId === owner.environmentId &&
    placement.activeOwnerEpoch === owner.ownerEpoch &&
    placement.generation > owner.placementGeneration
    ? "retained-failed"
    : undefined;
}

function listEnvironmentTeardownFences(
  db: DatabaseSync,
  environmentId: string,
): WorkerEnvironmentTeardownFence[] {
  const fences: WorkerEnvironmentTeardownFence[] = [];
  const pendingRows = executeSqliteQuerySync(
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
      ])
      .where("environment_id", "=", environmentId)
      .orderBy("session_id"),
  ).rows;
  for (const row of pendingRows) {
    const owner = {
      sessionId: row.session_id,
      environmentId: row.environment_id,
      ownerEpoch: row.owner_epoch,
      placementGeneration: row.placement_generation,
      claimId: row.claim_id,
      runId: row.run_id,
    };
    const ownerState = classifyPendingWorkspaceResultOwner(
      findPlacement(db, owner.sessionId),
      owner,
    );
    if (ownerState) {
      fences.push({
        kind: "pending-workspace-result",
        ownerState,
        sessionId: owner.sessionId,
        environmentId: owner.environmentId,
        ownerEpoch: owner.ownerEpoch,
        placementGeneration: owner.placementGeneration,
      });
    }
  }
  const journalRows = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_reconciliations")
      .select([
        "session_id",
        "environment_id",
        "owner_epoch",
        "placement_generation",
        "forced_abandonment_retained",
      ])
      .where("environment_id", "=", environmentId)
      .orderBy("session_id"),
  ).rows;
  for (const row of journalRows) {
    const owner = {
      sessionId: row.session_id,
      environmentId: row.environment_id,
      ownerEpoch: row.owner_epoch,
      placementGeneration: row.placement_generation,
    };
    const ownerState = classifyWorkspaceJournalOwner(
      findPlacement(db, owner.sessionId),
      owner,
      row.forced_abandonment_retained === 1,
    );
    if (ownerState) {
      fences.push({ kind: "workspace-reconciliation", ownerState, ...owner });
    }
  }
  return fences;
}

function isExactFenceOwner(
  fence: WorkerEnvironmentTeardownFence,
  owner: WorkerPendingResultOwnerIdentity,
): boolean {
  return (
    fence.sessionId === owner.sessionId &&
    fence.environmentId === owner.environmentId &&
    fence.ownerEpoch === owner.ownerEpoch &&
    fence.placementGeneration === owner.placementGeneration
  );
}

function canDestroyAcceptedWorkspaceResult(
  db: DatabaseSync,
  claim: WorkerSessionTurnClaim,
): boolean {
  if (claim.owner.kind !== "worker") {
    return false;
  }
  const pending = executeSqliteQuerySync(
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
      ])
      .where("session_id", "=", claim.sessionId)
      .where("environment_id", "=", claim.owner.environmentId)
      .where("owner_epoch", "=", claim.owner.ownerEpoch)
      .where("placement_generation", "=", claim.placementGeneration)
      .where("claim_id", "=", claim.claimId)
      .where("run_id", "=", claim.runId)
      .where("workspace_accepted_at_ms", "is not", null),
  ).rows[0];
  if (!pending) {
    return false;
  }
  const owner = {
    sessionId: pending.session_id,
    environmentId: pending.environment_id,
    ownerEpoch: pending.owner_epoch,
    placementGeneration: pending.placement_generation,
    claimId: pending.claim_id,
    runId: pending.run_id,
  };
  if (
    classifyPendingWorkspaceResultOwner(findPlacement(db, owner.sessionId), owner) !== "current"
  ) {
    return false;
  }
  const fences = listEnvironmentTeardownFences(db, owner.environmentId);
  return fences.length > 0 && fences.every((fence) => isExactFenceOwner(fence, owner));
}

function canDestroyForceAbandonedEnvironment(db: DatabaseSync, environmentId: string): boolean {
  const pending = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .select("session_id")
      .where("environment_id", "=", environmentId)
      .limit(1),
  ).rows[0];
  if (pending) {
    return false;
  }
  const relatedPlacements = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_session_placements")
      .select(["session_id", "state", "turn_claim_owner"])
      .where("environment_id", "=", environmentId)
      .where("state", "not in", ["local", "reclaimed"]),
  ).rows;
  if (
    relatedPlacements.some(
      (placement) => placement.state !== "failed" || placement.turn_claim_owner !== null,
    )
  ) {
    return false;
  }
  return listEnvironmentTeardownFences(db, environmentId).every(
    (fence) => fence.kind === "workspace-reconciliation" && fence.ownerState === "retained-failed",
  );
}

export function findWorkerTerminalRecovery(
  db: DatabaseSync,
  placement: WorkerSessionPlacementRecord,
): WorkerTerminalRecovery | undefined {
  if (placement.state !== "failed" || !placement.environmentId) {
    return undefined;
  }
  const pending = executeSqliteQuerySync(
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
      ])
      .where("session_id", "=", placement.sessionId),
  ).rows[0];
  const retainedPendingOwner =
    pending &&
    classifyPendingWorkspaceResultOwner(placement, {
      sessionId: pending.session_id,
      environmentId: pending.environment_id,
      ownerEpoch: pending.owner_epoch,
      placementGeneration: pending.placement_generation,
      claimId: pending.claim_id,
      runId: pending.run_id,
    }) === "retained-failed";
  const retainedJournalOwner =
    !retainedPendingOwner &&
    canDestroyForceAbandonedEnvironment(db, placement.environmentId) &&
    listEnvironmentTeardownFences(db, placement.environmentId).some(
      (fence) =>
        fence.kind === "workspace-reconciliation" &&
        fence.ownerState === "retained-failed" &&
        fence.sessionId === placement.sessionId,
    );
  if (!retainedPendingOwner && !retainedJournalOwner) {
    return undefined;
  }
  return {
    action: "force-destroy-environment",
    dataLoss: "unreconciled-workspace-result",
  };
}

export function createPlacementTeardownFenceOps(runtime: PlacementStoreRuntime) {
  const { read } = runtime;
  return {
    listEnvironmentTeardownFences(environmentId: string): WorkerEnvironmentTeardownFence[] {
      return listEnvironmentTeardownFences(read(), environmentId);
    },

    isEnvironmentTeardownFenced(environmentId: string): boolean {
      return listEnvironmentTeardownFences(read(), environmentId).length > 0;
    },

    canDestroyAcceptedWorkspaceResult(claim: WorkerSessionTurnClaim): boolean {
      return canDestroyAcceptedWorkspaceResult(read(), claim);
    },

    canDestroyForceAbandonedEnvironment(environmentId: string): boolean {
      return canDestroyForceAbandonedEnvironment(read(), environmentId);
    },
  };
}
