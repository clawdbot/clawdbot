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
        ...(record.environmentId ? { environmentId: record.environmentId } : {}),
      };
    case "syncing":
      return {
        state: "syncing",
        ...timing,
        environmentId: record.environmentId,
        workerBundleHash: record.workerBundleHash,
      };
    case "starting":
      return {
        state: "starting",
        ...timing,
        environmentId: record.environmentId,
        workerBundleHash: record.workerBundleHash,
        workspaceBaseManifestRef: record.workspaceBaseManifestRef,
        remoteWorkspaceDir: record.remoteWorkspaceDir,
      };
    case "active":
      return {
        state: "active",
        ...timing,
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
        ...(diskSpace ? { diskSpace } : {}),
        ...(runner ? { runner } : {}),
        ...conflict,
      };
    case "draining":
      return {
        state: "draining",
        ...timing,
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
        ...conflict,
      };
    case "reconciling":
      return {
        state: "reconciling",
        ...timing,
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
        ...conflict,
      };
    case "reclaimed":
      return {
        state: "reclaimed",
        ...timing,
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
        ...terminal,
      };
    case "failed":
      return {
        state: "failed",
        ...timing,
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
        recoveryError: record.recoveryError,
        ...terminal,
      };
  }
  // Exhaustive over placement states; the return satisfies consistent-return.
  return record satisfies never;
}
