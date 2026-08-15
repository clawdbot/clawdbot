import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionTurnClaim,
  WorkerTerminalRecovery,
} from "./placement-record.js";
import { find as findPlacement, fromRow } from "./placement-row-codec.js";
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

type WorkerWorkspaceJournalOwner = WorkerWorkspaceOwnerIdentity & {
  retained: boolean;
};

type EnvironmentTeardownFacts = {
  fencesByEnvironment: ReadonlyMap<string, readonly WorkerEnvironmentTeardownFence[]>;
  pendingEnvironmentIds: ReadonlySet<string>;
  pendingOwnersBySession: ReadonlyMap<string, WorkerPendingResultOwnerIdentity>;
  relatedPlacementsByEnvironment: ReadonlyMap<string, readonly WorkerSessionPlacementRecord[]>;
};

function appendGrouped<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key);
  if (group) {
    group.push(value);
    return;
  }
  groups.set(key, [value]);
}

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

function loadEnvironmentTeardownFacts(
  db: DatabaseSync,
  environmentIds: readonly string[],
): EnvironmentTeardownFacts {
  // Keep bulk placement projection on one bounded fact load. Per-row discovery here
  // synchronously amplifies sessions.list latency for every failed placement.
  const uniqueEnvironmentIds = [...new Set(environmentIds)];
  const pendingOwners: WorkerPendingResultOwnerIdentity[] = [];
  const journalOwners: WorkerWorkspaceJournalOwner[] = [];
  const relatedPlacementsByEnvironment = new Map<string, WorkerSessionPlacementRecord[]>();
  const placementsBySession = new Map<string, WorkerSessionPlacementRecord>();
  for (let offset = 0; offset < uniqueEnvironmentIds.length; offset += 250) {
    const chunk = uniqueEnvironmentIds.slice(offset, offset + 250);
    for (const row of executeSqliteQuerySync(
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
        .where("environment_id", "in", chunk)
        .orderBy("environment_id")
        .orderBy("session_id"),
    ).rows) {
      pendingOwners.push({
        sessionId: row.session_id,
        environmentId: row.environment_id,
        ownerEpoch: row.owner_epoch,
        placementGeneration: row.placement_generation,
        claimId: row.claim_id,
        runId: row.run_id,
      });
    }
    for (const row of executeSqliteQuerySync(
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
        .where("environment_id", "in", chunk)
        .orderBy("environment_id")
        .orderBy("session_id"),
    ).rows) {
      journalOwners.push({
        sessionId: row.session_id,
        environmentId: row.environment_id,
        ownerEpoch: row.owner_epoch,
        placementGeneration: row.placement_generation,
        retained: row.forced_abandonment_retained === 1,
      });
    }
    for (const row of executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_session_placements")
        .selectAll()
        .where("environment_id", "in", chunk)
        .where("state", "not in", ["local", "reclaimed"]),
    ).rows) {
      const placement = fromRow(row);
      if (!placement.environmentId) {
        throw new Error(`Worker placement ${placement.sessionId} lost its environment ownership`);
      }
      placementsBySession.set(placement.sessionId, placement);
      appendGrouped(relatedPlacementsByEnvironment, placement.environmentId, placement);
    }
  }

  const pendingOwnersBySession = new Map<string, WorkerPendingResultOwnerIdentity>();
  const pendingEnvironmentIds = new Set<string>();
  const fencesByEnvironment = new Map<string, WorkerEnvironmentTeardownFence[]>();
  for (const owner of pendingOwners) {
    pendingOwnersBySession.set(owner.sessionId, owner);
    pendingEnvironmentIds.add(owner.environmentId);
    const ownerState = classifyPendingWorkspaceResultOwner(
      placementsBySession.get(owner.sessionId),
      owner,
    );
    if (ownerState) {
      appendGrouped(fencesByEnvironment, owner.environmentId, {
        kind: "pending-workspace-result",
        ownerState,
        sessionId: owner.sessionId,
        environmentId: owner.environmentId,
        ownerEpoch: owner.ownerEpoch,
        placementGeneration: owner.placementGeneration,
      });
    }
  }
  for (const { retained, ...owner } of journalOwners) {
    const ownerState = classifyWorkspaceJournalOwner(
      placementsBySession.get(owner.sessionId),
      owner,
      retained,
    );
    if (ownerState) {
      appendGrouped(fencesByEnvironment, owner.environmentId, {
        kind: "workspace-reconciliation",
        ownerState,
        ...owner,
      });
    }
  }
  return {
    fencesByEnvironment,
    pendingEnvironmentIds,
    pendingOwnersBySession,
    relatedPlacementsByEnvironment,
  };
}

function listEnvironmentTeardownFences(
  db: DatabaseSync,
  environmentId: string,
): WorkerEnvironmentTeardownFence[] {
  return [
    ...(loadEnvironmentTeardownFacts(db, [environmentId]).fencesByEnvironment.get(environmentId) ??
      []),
  ];
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

function canDestroyForceAbandonedEnvironmentFromFacts(
  facts: EnvironmentTeardownFacts,
  environmentId: string,
): boolean {
  if (
    facts.pendingEnvironmentIds.has(environmentId) ||
    (facts.relatedPlacementsByEnvironment.get(environmentId) ?? []).some(
      (placement) => placement.state !== "failed" || placement.turnClaim !== null,
    )
  ) {
    return false;
  }
  return (facts.fencesByEnvironment.get(environmentId) ?? []).every(
    (fence) => fence.kind === "workspace-reconciliation" && fence.ownerState === "retained-failed",
  );
}

function canDestroyForceAbandonedEnvironment(db: DatabaseSync, environmentId: string): boolean {
  return canDestroyForceAbandonedEnvironmentFromFacts(
    loadEnvironmentTeardownFacts(db, [environmentId]),
    environmentId,
  );
}

export function findWorkerTerminalRecoveries(
  db: DatabaseSync,
  placements: readonly WorkerSessionPlacementRecord[],
): ReadonlyMap<string, WorkerTerminalRecovery> {
  const failedPlacements = placements.filter(
    (placement) => placement.state === "failed" && placement.environmentId,
  );
  const recoveries = new Map<string, WorkerTerminalRecovery>();
  if (failedPlacements.length === 0) {
    return recoveries;
  }
  const facts = loadEnvironmentTeardownFacts(
    db,
    failedPlacements.map((placement) => placement.environmentId!),
  );
  for (const placement of failedPlacements) {
    const environmentId = placement.environmentId!;
    const pendingOwner = facts.pendingOwnersBySession.get(placement.sessionId);
    const retainedPendingOwner =
      pendingOwner &&
      classifyPendingWorkspaceResultOwner(placement, pendingOwner) === "retained-failed";
    const retainedJournalOwner =
      !retainedPendingOwner &&
      canDestroyForceAbandonedEnvironmentFromFacts(facts, environmentId) &&
      (facts.fencesByEnvironment.get(environmentId) ?? []).some(
        (fence) =>
          fence.kind === "workspace-reconciliation" &&
          fence.ownerState === "retained-failed" &&
          fence.sessionId === placement.sessionId,
      );
    if (retainedPendingOwner || retainedJournalOwner) {
      recoveries.set(placement.sessionId, {
        action: "force-destroy-environment",
        dataLoss: "unreconciled-workspace-result",
      });
    }
  }
  return recoveries;
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
