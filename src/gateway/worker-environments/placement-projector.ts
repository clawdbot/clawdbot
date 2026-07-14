import type { SessionPlacement } from "../../../packages/gateway-protocol/src/index.js";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";

export type WorkerSessionPlacementReader = {
  getMany(sessionIds: readonly string[]): ReadonlyMap<string, WorkerSessionPlacementRecord>;
};

/** Removes gateway-only identity and turn-claim fields from the operator projection. */
export function projectWorkerSessionPlacement(
  record: WorkerSessionPlacementRecord,
): SessionPlacement {
  const timing = {
    generation: record.generation,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    stateChangedAtMs: record.stateChangedAtMs,
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
        recoveryError: record.recoveryError,
      };
  }
  // Exhaustive over placement states; the return satisfies consistent-return.
  return record satisfies never;
}
