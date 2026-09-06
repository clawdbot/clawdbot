import type {
  SessionPlacement,
  SessionPlacementDiskSpace,
  SessionPlacementMove,
  SessionPlacementRunner,
} from "../../../packages/gateway-protocol/src/index.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";

export type WorkerSessionPlacementReader = {
  getMany(sessionIds: readonly string[]): ReadonlyMap<string, WorkerSessionPlacementRecord>;
  /** Runtime consumers may cancel work when the exact captured turn claim closes. */
  registerTurnClaimClosedHandler?: (
    handler: (claim: import("./placement-record.js").WorkerSessionTurnClaim) => void,
  ) => () => void;
  getPlacementMoves?(sessionIds: readonly string[]): ReadonlyMap<string, WorkerPlacementMoveIntent>;
};

export type WorkerPlacementDiskSpaceReader = {
  read(record: WorkerSessionPlacementRecord): SessionPlacementDiskSpace | undefined;
  version(): number;
};

export type WorkerPlacementRunnerAvailabilityReader = {
  read(record: WorkerSessionPlacementRecord): SessionPlacementRunner | undefined;
  version(): number;
};

export function readWorkerPlacementIdentity(
  record: WorkerSessionPlacementRecord,
  environments: Pick<WorkerEnvironmentServiceContract, "get"> | undefined,
): { providerId: string; profileId: string } | undefined {
  const environment = record.environmentId ? environments?.get(record.environmentId) : undefined;
  if (!environment) {
    return undefined;
  }
  // Epochs correlate instances even when an environment id is reused. Matching terminal
  // environments retain accurate runner provenance; only pre-epoch dispatch states may
  // expose identity without an epoch, never terminal placements that retained none.
  const correlated =
    record.activeOwnerEpoch !== null
      ? environment.ownerEpoch === record.activeOwnerEpoch
      : record.state === "provisioning" ||
        record.state === "syncing" ||
        record.state === "starting";
  return correlated
    ? { providerId: environment.providerId, profileId: environment.profileId }
    : undefined;
}

export function createWorkerPlacementRunnerAvailabilityReader(params: {
  environments: Pick<WorkerEnvironmentServiceContract, "get">;
  hasCurrentDeviceRunner: (deviceId: string) => boolean;
}): WorkerPlacementRunnerAvailabilityReader & { markChanged(): void } {
  let version = 0;
  const read: WorkerPlacementRunnerAvailabilityReader["read"] = (record) => {
    if (record.state !== "active") {
      return undefined;
    }
    const environment = params.environments.get(record.environmentId);
    if (
      environment?.providerId !== DEVICE_WORKER_PROVIDER_ID ||
      environment.state !== "attached" ||
      environment.ownerEpoch !== record.activeOwnerEpoch ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== record.sessionId ||
      !environment.nodeDeviceId
    ) {
      return undefined;
    }
    return {
      kind: "device",
      deviceId: environment.nodeDeviceId,
      status: params.hasCurrentDeviceRunner(environment.nodeDeviceId) ? "available" : "offline",
    };
  };
  return {
    read,
    markChanged: () => {
      version += 1;
    },
    version: () => version,
  };
}

export function projectWorkerPlacementMove(
  intent: WorkerPlacementMoveIntent,
): SessionPlacementMove {
  return {
    target: intent.target,
    updatedAtMs: intent.updatedAtMs,
    ...(intent.lastError ? { error: intent.lastError } : {}),
  };
}

/** Removes gateway-only identity and turn-claim fields from the operator projection. */
export function projectWorkerSessionPlacement(
  record: WorkerSessionPlacementRecord,
  diskSpace?: SessionPlacementDiskSpace,
  runner?: SessionPlacementRunner,
  identity?: { providerId: string; profileId: string },
  failedRecoveryAction?: "restart" | "stop-first",
): SessionPlacement {
  const timing = {
    generation: record.generation,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    stateChangedAtMs: record.stateChangedAtMs,
  };
  const conflict = record.workspaceResultConflict
    ? { workspaceResultConflict: record.workspaceResultConflict }
    : {};
  const terminal = {
    ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
    ...(record.terminalAtMs !== null ? { terminalAtMs: record.terminalAtMs } : {}),
  };
  switch (record.state) {
    case "local":
      return { state: "local", ...timing };
    case "requested":
      return { state: "requested", ...timing };
    case "provisioning":
      return {
        state: "provisioning",
        ...timing,
        ...identity,
        ...(record.environmentId ? { environmentId: record.environmentId } : {}),
      };
    case "syncing":
      return {
        state: "syncing",
        ...timing,
        ...identity,
        environmentId: record.environmentId,
        workerBundleHash: record.workerBundleHash,
      };
    case "starting":
      return {
        state: "starting",
        ...timing,
        ...identity,
        environmentId: record.environmentId,
        workerBundleHash: record.workerBundleHash,
        workspaceBaseManifestRef: record.workspaceBaseManifestRef,
        remoteWorkspaceDir: record.remoteWorkspaceDir,
      };
    case "active":
    case "draining":
    case "reconciling":
      return {
        state: record.state,
        ...timing,
        ...identity,
        environmentId: record.environmentId,
        activeOwnerEpoch: record.activeOwnerEpoch,
        workerBundleHash: record.workerBundleHash,
        workspaceBaseManifestRef: record.workspaceBaseManifestRef,
        remoteWorkspaceDir: record.remoteWorkspaceDir,
        ...(record.lastTranscriptAckCursor !== null
          ? { lastTranscriptAckCursor: record.lastTranscriptAckCursor }
          : {}),
        ...(record.lastLiveEventAckCursor !== null
          ? { lastLiveEventAckCursor: record.lastLiveEventAckCursor }
          : {}),
        ...(record.state === "active" && diskSpace ? { diskSpace } : {}),
        ...(record.state === "active" && runner ? { runner } : {}),
        ...conflict,
      };
    case "reclaimed":
    case "failed": {
      const retained = {
        ...timing,
        ...identity,
        ...(record.environmentId ? { environmentId: record.environmentId } : {}),
        ...(record.activeOwnerEpoch !== null ? { activeOwnerEpoch: record.activeOwnerEpoch } : {}),
        ...(record.workspaceBaseManifestRef
          ? { workspaceBaseManifestRef: record.workspaceBaseManifestRef }
          : {}),
        ...(record.remoteWorkspaceDir ? { remoteWorkspaceDir: record.remoteWorkspaceDir } : {}),
        ...(record.workerBundleHash ? { workerBundleHash: record.workerBundleHash } : {}),
        ...(record.lastTranscriptAckCursor !== null
          ? { lastTranscriptAckCursor: record.lastTranscriptAckCursor }
          : {}),
        ...(record.lastLiveEventAckCursor !== null
          ? { lastLiveEventAckCursor: record.lastLiveEventAckCursor }
          : {}),
        ...conflict,
      };
      return record.state === "failed"
        ? {
            state: "failed",
            ...retained,
            recoveryError: record.recoveryError,
            ...(failedRecoveryAction ? { recoveryAction: failedRecoveryAction } : {}),
            ...terminal,
          }
        : { state: "reclaimed", ...retained, ...terminal };
    }
  }
  // Exhaustive over placement states; the return satisfies consistent-return.
  return record satisfies never;
}
