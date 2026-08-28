import type { WorkerSessionPlacementState } from "./placement-state.js";

export type WorkerSessionPlacementIdentity = {
  sessionId: string;
  agentId: string;
  sessionKey: string;
};

export type WorkerPlacementExecutionMode = "worker-turn" | "remote-exec";
export type WorkerSessionPlacementDispatchIdentity = WorkerSessionPlacementIdentity & {
  executionMode?: WorkerPlacementExecutionMode;
};

export type WorkerSessionTurnOwner =
  | { kind: "local"; environmentId?: string; ownerEpoch?: number }
  | { kind: "worker"; environmentId: string; ownerEpoch: number };

export type WorkerSessionTurnClaim = {
  sessionId: string;
  claimId: string;
  runId: string;
  placementGeneration: number;
  owner: WorkerSessionTurnOwner;
};

export function serializeWorkerSessionTurnClaim(claim: WorkerSessionTurnClaim): string {
  if (claim.owner.kind !== "worker") {
    throw new Error("Worker claim identity requires a worker-owned claim");
  }
  return JSON.stringify([
    claim.sessionId,
    claim.owner.environmentId,
    claim.owner.ownerEpoch,
    claim.runId,
    claim.claimId,
    claim.placementGeneration,
  ]);
}

export function sameWorkerSessionTurnClaim(
  left: WorkerSessionTurnClaim,
  right: WorkerSessionTurnClaim,
): boolean {
  if (left.owner.kind !== "worker" || right.owner.kind !== "worker") {
    throw new Error("Worker claim identity requires a worker-owned claim");
  }
  return (
    left.sessionId === right.sessionId &&
    left.owner.environmentId === right.owner.environmentId &&
    left.owner.ownerEpoch === right.owner.ownerEpoch &&
    left.runId === right.runId &&
    left.claimId === right.claimId &&
    left.placementGeneration === right.placementGeneration
  );
}

export function placementTurnOwner(placement: {
  executionMode: WorkerPlacementExecutionMode;
  environmentId: string;
  activeOwnerEpoch: number;
}): WorkerSessionTurnOwner {
  return {
    kind: placement.executionMode === "remote-exec" ? "local" : "worker",
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
  };
}

export type PersistedTurnClaim =
  | {
      owner: "local";
      claimId: string;
      runId: string;
      generation: number;
      ownerEpoch: null;
    }
  | {
      owner: "worker";
      claimId: string;
      runId: string;
      generation: number;
      ownerEpoch: number;
    };

export type WorkerWorkspaceResultConflict = {
  paths: string[];
  stagedResultRef: string;
  totalCount?: number;
};

type PersistedLocalTurnClaim = Extract<PersistedTurnClaim, { owner: "local" }>;

type PlacementRecordBase<TurnClaim extends PersistedTurnClaim | null> =
  WorkerSessionPlacementIdentity & {
    generation: number;
    executionMode: WorkerPlacementExecutionMode;
    turnClaim: TurnClaim;
    createdAtMs: number;
    updatedAtMs: number;
    stateChangedAtMs: number;
    /** Process-local UI projection; deliberately absent from SQLite. */
    workspaceResultConflict?: WorkerWorkspaceResultConflict;
  };

type UnclaimedPlacementRecordBase = PlacementRecordBase<null>;
type LocalClaimablePlacementRecordBase = PlacementRecordBase<PersistedLocalTurnClaim | null>;

export type EmptyWorkerPlacementMetadata = {
  environmentId: null;
  activeOwnerEpoch: null;
  workspaceBaseManifestRef: null;
  remoteWorkspaceDir: null;
  workerBundleHash: null;
  lastTranscriptAckCursor: null;
  lastLiveEventAckCursor: null;
  recoveryError: null;
  terminalReason: null;
  terminalAtMs: null;
};

type ProvisioningPlacementMetadata = {
  environmentId: string | null;
  activeOwnerEpoch: null;
  workspaceBaseManifestRef: null;
  remoteWorkspaceDir: null;
  workerBundleHash: null;
  lastTranscriptAckCursor: null;
  lastLiveEventAckCursor: null;
  recoveryError: null;
  terminalReason: null;
  terminalAtMs: null;
};

type SyncingPlacementMetadata = {
  environmentId: string;
  activeOwnerEpoch: null;
  workspaceBaseManifestRef: null;
  remoteWorkspaceDir: null;
  workerBundleHash: string;
  lastTranscriptAckCursor: null;
  lastLiveEventAckCursor: null;
  recoveryError: null;
  terminalReason: null;
  terminalAtMs: null;
};

type StartingPlacementMetadata = {
  environmentId: string;
  activeOwnerEpoch: null;
  workspaceBaseManifestRef: string;
  remoteWorkspaceDir: string;
  workerBundleHash: string;
  lastTranscriptAckCursor: null;
  lastLiveEventAckCursor: null;
  recoveryError: null;
  terminalReason: null;
  terminalAtMs: null;
};

export type OwnedWorkerPlacementMetadata = {
  environmentId: string;
  activeOwnerEpoch: number;
  workspaceBaseManifestRef: string;
  remoteWorkspaceDir: string;
  workerBundleHash: string;
  lastTranscriptAckCursor: number | null;
  lastLiveEventAckCursor: number | null;
  recoveryError: null;
  terminalReason: null;
  terminalAtMs: null;
};

type TerminalPlacementMetadata = {
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  workspaceBaseManifestRef: string | null;
  remoteWorkspaceDir: string | null;
  workerBundleHash: string | null;
  lastTranscriptAckCursor: number | null;
  lastLiveEventAckCursor: number | null;
  terminalReason: string | null;
  terminalAtMs: number | null;
};

type LocalPlacementRecord = LocalClaimablePlacementRecordBase &
  EmptyWorkerPlacementMetadata & {
    state: "local";
  };
type RequestedPlacementRecord = LocalClaimablePlacementRecordBase &
  EmptyWorkerPlacementMetadata & {
    state: "requested";
  };
type ProvisioningPlacementRecord = UnclaimedPlacementRecordBase &
  ProvisioningPlacementMetadata & {
    state: "provisioning";
  };
type SyncingPlacementRecord = UnclaimedPlacementRecordBase &
  SyncingPlacementMetadata & {
    state: "syncing";
  };
type StartingPlacementRecord = UnclaimedPlacementRecordBase &
  StartingPlacementMetadata & {
    state: "starting";
  };
type ActivePlacementRecord = PlacementRecordBase<PersistedTurnClaim | null> &
  OwnedWorkerPlacementMetadata & {
    state: "active";
  };
type DrainingPlacementRecord = PlacementRecordBase<PersistedTurnClaim | null> &
  OwnedWorkerPlacementMetadata & {
    state: "draining";
  };
type ReconcilingPlacementRecord = UnclaimedPlacementRecordBase &
  OwnedWorkerPlacementMetadata & {
    state: "reconciling";
  };
type ReclaimedPlacementRecord = UnclaimedPlacementRecordBase &
  Omit<OwnedWorkerPlacementMetadata, "terminalReason" | "terminalAtMs"> &
  TerminalPlacementMetadata & {
    state: "reclaimed";
  };
type FailedPlacementRecord = LocalClaimablePlacementRecordBase &
  TerminalPlacementMetadata & {
    state: "failed";
    recoveryError: string;
  };

export type WorkerSessionPlacementRecord =
  | LocalPlacementRecord
  | RequestedPlacementRecord
  | ProvisioningPlacementRecord
  | SyncingPlacementRecord
  | StartingPlacementRecord
  | ActivePlacementRecord
  | DrainingPlacementRecord
  | ReconcilingPlacementRecord
  | ReclaimedPlacementRecord
  | FailedPlacementRecord;

export function projectWorkerSessionTurnClaim(
  record: WorkerSessionPlacementRecord,
): WorkerSessionTurnClaim | undefined {
  const claim = record.turnClaim;
  return claim?.owner === "worker" &&
    (record.state === "active" || record.state === "draining") &&
    record.environmentId &&
    record.activeOwnerEpoch === claim.ownerEpoch
    ? {
        sessionId: record.sessionId,
        claimId: claim.claimId,
        runId: claim.runId,
        placementGeneration: claim.generation,
        owner: {
          kind: "worker",
          environmentId: record.environmentId,
          ownerEpoch: claim.ownerEpoch,
        },
      }
    : undefined;
}

export type WorkerSessionPlacementTransitionPatch = {
  environmentId?: string | null;
  activeOwnerEpoch?: number | null;
  workspaceBaseManifestRef?: string | null;
  remoteWorkspaceDir?: string | null;
  workerBundleHash?: string | null;
  lastTranscriptAckCursor?: number | null;
  lastLiveEventAckCursor?: number | null;
  recoveryError?: string | null;
  terminalReason?: string | null;
};

export function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Worker session placement ${field} must be a non-empty string`);
  }
  return normalized;
}

export function normalizeWorkerPlacementExecutionMode(
  value: string | null | undefined,
): WorkerPlacementExecutionMode {
  if (value === null || value === undefined || value === "worker-turn") {
    return "worker-turn";
  }
  if (value === "remote-exec") {
    return value;
  }
  throw new Error(`Invalid worker placement execution mode: ${value}`);
}

export function nullableRequired(value: string | null, field: string): string | null {
  return value === null ? null : required(value, field);
}

export function normalizeEpoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Worker session placement ${field} must be a positive safe integer`);
  }
  return value;
}

export function normalizeCursor(value: number | null, field: string): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Worker session placement ${field} must be a non-negative safe integer`);
  }
  return value;
}

export function normalizeTimestamp(value: number | null, field: string): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Worker session placement ${field} must be a non-negative safe integer`);
  }
  return value;
}

export function advanceCursor(
  current: number | null,
  value: number | undefined,
  field: string,
): number | null {
  if (value === undefined) {
    return current;
  }
  const next = normalizeCursor(value, field);
  if (next === null || current === null) {
    return next ?? current;
  }
  return Math.max(current, next);
}

export function normalizeIdentity(
  input: WorkerSessionPlacementIdentity,
): WorkerSessionPlacementIdentity {
  return {
    sessionId: required(input.sessionId, "session id"),
    agentId: required(input.agentId, "agent id"),
    sessionKey: required(input.sessionKey, "session key"),
  };
}

export function nextGeneration(generation: number): number {
  const next = generation + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("Worker session placement generation is exhausted");
  }
  return next;
}

export function localTurnClaimForState(
  turnClaim: PersistedTurnClaim | null,
  state: "local" | "requested" | "failed",
): PersistedLocalTurnClaim | null {
  if (turnClaim?.owner === "worker") {
    throw new Error(`Worker turn claim cannot survive placement ${state}`);
  }
  return turnClaim;
}

export function activeTurnClaimForState(
  turnClaim: PersistedTurnClaim | null,
  state: "active" | "draining",
  executionMode: WorkerPlacementExecutionMode,
): PersistedTurnClaim | null {
  if (
    (turnClaim?.owner === "local" && executionMode !== "remote-exec") ||
    (turnClaim?.owner === "worker" && executionMode !== "worker-turn")
  ) {
    throw new Error(`Turn claim owner does not match ${executionMode} placement ${state}`);
  }
  return turnClaim;
}

export function unclaimedTurnForState(
  turnClaim: PersistedTurnClaim | null,
  state: "provisioning" | "syncing" | "starting" | "reconciling" | "reclaimed",
): null {
  if (turnClaim !== null) {
    throw new Error(`Turn claim cannot survive placement ${state}`);
  }
  return null;
}

export function assertRecordShape(record: {
  state: WorkerSessionPlacementState;
  executionMode: WorkerPlacementExecutionMode;
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  workspaceBaseManifestRef: string | null;
  remoteWorkspaceDir: string | null;
  workerBundleHash: string | null;
  lastTranscriptAckCursor: number | null;
  lastLiveEventAckCursor: number | null;
  recoveryError: string | null;
  terminalReason: string | null;
  terminalAtMs: number | null;
  turnClaim: PersistedTurnClaim | null;
}): void {
  const terminal = record.state === "reclaimed" || record.state === "failed";
  if (terminal) {
    normalizeTimestamp(record.terminalAtMs, "terminal timestamp");
    if (record.state === "reclaimed" && record.terminalReason !== null) {
      throw new Error("Reclaimed worker session placement cannot retain a terminal reason");
    }
    if (record.terminalReason !== null) {
      required(record.terminalReason, "terminal reason");
    }
  } else if (record.terminalReason !== null || record.terminalAtMs !== null) {
    throw new Error(`Worker session placement ${record.state} cannot retain terminal facts`);
  }
  if (record.state === "local" || record.state === "requested") {
    if (
      record.environmentId !== null ||
      record.activeOwnerEpoch !== null ||
      record.workspaceBaseManifestRef !== null ||
      record.remoteWorkspaceDir !== null ||
      record.workerBundleHash !== null ||
      record.lastTranscriptAckCursor !== null ||
      record.lastLiveEventAckCursor !== null ||
      record.recoveryError !== null
    ) {
      throw new Error(`Worker session placement ${record.state} cannot retain worker metadata`);
    }
  } else if (record.state === "provisioning") {
    if (
      record.activeOwnerEpoch !== null ||
      record.workspaceBaseManifestRef !== null ||
      record.remoteWorkspaceDir !== null ||
      record.workerBundleHash !== null ||
      record.lastTranscriptAckCursor !== null ||
      record.lastLiveEventAckCursor !== null ||
      record.recoveryError !== null
    ) {
      throw new Error("Provisioning worker session placement can only retain an environment id");
    }
  } else if (record.state === "syncing") {
    if (
      !record.environmentId ||
      record.activeOwnerEpoch !== null ||
      record.workspaceBaseManifestRef !== null ||
      record.remoteWorkspaceDir !== null ||
      !record.workerBundleHash ||
      record.lastTranscriptAckCursor !== null ||
      record.lastLiveEventAckCursor !== null ||
      record.recoveryError !== null
    ) {
      throw new Error("Syncing worker session placement requires an environment and bundle");
    }
  } else if (record.state === "starting") {
    if (
      !record.environmentId ||
      record.activeOwnerEpoch !== null ||
      !record.workspaceBaseManifestRef ||
      !record.remoteWorkspaceDir ||
      !record.workerBundleHash ||
      record.lastTranscriptAckCursor !== null ||
      record.lastLiveEventAckCursor !== null ||
      record.recoveryError !== null
    ) {
      throw new Error("Starting worker session placement requires complete workspace metadata");
    }
  } else if (
    record.state === "active" ||
    record.state === "draining" ||
    record.state === "reconciling" ||
    record.state === "reclaimed"
  ) {
    if (
      !record.environmentId ||
      record.activeOwnerEpoch === null ||
      !record.workspaceBaseManifestRef ||
      !record.remoteWorkspaceDir ||
      !record.workerBundleHash ||
      record.recoveryError !== null
    ) {
      throw new Error(
        `Worker session placement ${record.state} requires complete worker ownership`,
      );
    }
    normalizeEpoch(record.activeOwnerEpoch, "active owner epoch");
  } else if (!record.recoveryError) {
    throw new Error("Failed worker session placement requires a recovery error");
  }
  if (
    record.turnClaim?.owner === "local" &&
    record.state !== "local" &&
    record.state !== "requested" &&
    record.state !== "failed" &&
    !(
      record.executionMode === "remote-exec" &&
      (record.state === "active" || record.state === "draining")
    )
  ) {
    throw new Error("Local turn claim requires local, dispatch-barrier, or failed placement");
  }
  if (record.turnClaim?.owner === "worker") {
    const workerMayFinish = record.state === "active" || record.state === "draining";
    if (
      record.executionMode !== "worker-turn" ||
      !workerMayFinish ||
      record.activeOwnerEpoch !== record.turnClaim.ownerEpoch
    ) {
      throw new Error("Worker turn claim requires the active or draining worker owner epoch");
    }
  }
}

export function isCurrentPlacementTurnClaim(
  record: WorkerSessionPlacementRecord,
  claim: WorkerSessionTurnClaim,
): boolean {
  const persisted = record.turnClaim;
  if (
    !persisted ||
    persisted.claimId !== claim.claimId ||
    persisted.runId !== claim.runId ||
    persisted.generation !== claim.placementGeneration ||
    persisted.owner !== claim.owner.kind
  ) {
    return false;
  }
  if (claim.owner.kind === "worker") {
    return (
      persisted.ownerEpoch === claim.owner.ownerEpoch &&
      record.executionMode === "worker-turn" &&
      (record.state === "active" || record.state === "draining") &&
      record.environmentId === claim.owner.environmentId &&
      record.activeOwnerEpoch === claim.owner.ownerEpoch
    );
  }
  if (record.state === "active" || record.state === "draining") {
    return (
      record.executionMode === "remote-exec" &&
      claim.owner.environmentId === record.environmentId &&
      claim.owner.ownerEpoch === record.activeOwnerEpoch
    );
  }
  if (
    record.state === "failed" &&
    record.executionMode === "remote-exec" &&
    record.environmentId &&
    record.activeOwnerEpoch !== null
  ) {
    return (
      claim.owner.environmentId === record.environmentId &&
      claim.owner.ownerEpoch === record.activeOwnerEpoch
    );
  }
  return (
    (record.state === "local" || record.state === "requested" || record.state === "failed") &&
    claim.owner.environmentId === undefined &&
    claim.owner.ownerEpoch === undefined
  );
}

export function resolvePlacementTurnEnvironment(
  record: WorkerSessionPlacementRecord,
  claim: WorkerSessionTurnClaim,
): { environmentId: string; ownerEpoch: number } | undefined {
  if (
    !isCurrentPlacementTurnClaim(record, claim) ||
    (record.state !== "active" && record.state !== "draining") ||
    !record.environmentId ||
    record.activeOwnerEpoch === null
  ) {
    return undefined;
  }
  return { environmentId: record.environmentId, ownerEpoch: record.activeOwnerEpoch };
}
