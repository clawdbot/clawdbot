import type { WorkerSessionPlacementState } from "./placement-state.js";

export type WorkerSessionPlacementIdentity = {
  sessionId: string;
  agentId: string;
  sessionKey: string;
};

export type WorkerSessionTurnOwner =
  | { kind: "local" }
  | { kind: "worker"; environmentId: string; ownerEpoch: number };

export type WorkerSessionTurnClaim = {
  sessionId: string;
  claimId: string;
  runId: string;
  placementGeneration: number;
  owner: WorkerSessionTurnOwner;
};

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
type PersistedWorkerTurnClaim = Extract<PersistedTurnClaim, { owner: "worker" }>;

type PlacementRecordBase<TurnClaim extends PersistedTurnClaim | null> =
  WorkerSessionPlacementIdentity & {
    generation: number;
    turnClaim: TurnClaim;
    createdAtMs: number;
    updatedAtMs: number;
    stateChangedAtMs: number;
    /** Process-local UI projection; deliberately absent from SQLite. */
    workspaceResultConflict?: WorkerWorkspaceResultConflict;
  };

type UnclaimedPlacementRecordBase = PlacementRecordBase<null>;
type LocalClaimablePlacementRecordBase = PlacementRecordBase<PersistedLocalTurnClaim | null>;
type WorkerClaimablePlacementRecordBase = PlacementRecordBase<PersistedWorkerTurnClaim | null>;

export type EmptyWorkerPlacementMetadata = {
  environmentId: null;
  activeOwnerEpoch: null;
  workspaceBaseManifestRef: null;
  remoteWorkspaceDir: null;
  workerBundleHash: null;
  lastTranscriptAckCursor: null;
  lastLiveEventAckCursor: null;
  recoveryError: null;
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
};

type TerminalPlacementMetadata = {
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  workspaceBaseManifestRef: string | null;
  remoteWorkspaceDir: string | null;
  workerBundleHash: string | null;
  lastTranscriptAckCursor: number | null;
  lastLiveEventAckCursor: number | null;
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
type ActivePlacementRecord = WorkerClaimablePlacementRecordBase &
  OwnedWorkerPlacementMetadata & {
    state: "active";
  };
type DrainingPlacementRecord = WorkerClaimablePlacementRecordBase &
  OwnedWorkerPlacementMetadata & {
    state: "draining";
  };
type ReconcilingPlacementRecord = UnclaimedPlacementRecordBase &
  OwnedWorkerPlacementMetadata & {
    state: "reconciling";
  };
type ReclaimedPlacementRecord = UnclaimedPlacementRecordBase &
  OwnedWorkerPlacementMetadata & {
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

export type WorkerSessionPlacementTransitionPatch = {
  environmentId?: string | null;
  activeOwnerEpoch?: number | null;
  workspaceBaseManifestRef?: string | null;
  remoteWorkspaceDir?: string | null;
  workerBundleHash?: string | null;
  lastTranscriptAckCursor?: number | null;
  lastLiveEventAckCursor?: number | null;
  recoveryError?: string | null;
};

export function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Worker session placement ${field} must be a non-empty string`);
  }
  return normalized;
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

export function workerTurnClaimForState(
  turnClaim: PersistedTurnClaim | null,
  state: "active" | "draining",
): PersistedWorkerTurnClaim | null {
  if (turnClaim?.owner === "local") {
    throw new Error(`Local turn claim cannot survive placement ${state}`);
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
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  workspaceBaseManifestRef: string | null;
  remoteWorkspaceDir: string | null;
  workerBundleHash: string | null;
  lastTranscriptAckCursor: number | null;
  lastLiveEventAckCursor: number | null;
  recoveryError: string | null;
  turnClaim: PersistedTurnClaim | null;
}): void {
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
    record.state !== "failed"
  ) {
    throw new Error("Local turn claim requires local, dispatch-barrier, or failed placement");
  }
  if (record.turnClaim?.owner === "worker") {
    const workerMayFinish = record.state === "active" || record.state === "draining";
    if (!workerMayFinish || record.activeOwnerEpoch !== record.turnClaim.ownerEpoch) {
      throw new Error("Worker turn claim requires the active or draining worker owner epoch");
    }
  }
}
