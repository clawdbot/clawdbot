import {
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  type WorkerAdmissionHandshake,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerProfile, WorkerSshEndpoint } from "../../plugins/types.js";
import type { WorkerDispatchEnvironmentService } from "./placement-dispatch-failure.js";
import type { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementRecord,
} from "./placement-store.js";
import { workerEnvironmentIdForIdempotencyKey } from "./service.js";

type WorkerDispatchRequest = Parameters<
  ReturnType<typeof createWorkerPlacementDispatchService>["dispatch"]
>[0];
export type PlacementStore = ReturnType<typeof createWorkerSessionPlacementStore>;
type DispatchEnvironmentRecord = Awaited<ReturnType<WorkerDispatchEnvironmentService["create"]>>;
export type DispatchStage =
  | "barrier"
  | "workspace"
  | "create"
  | "tunnel:ready"
  | "sync"
  | "attach"
  | "tunnel:attached"
  | "activation";

export const BUNDLE_HASH = "a".repeat(64);
export const MANIFEST_REF = `sha256:${"b".repeat(64)}`;
export const REQUEST: WorkerDispatchRequest = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  agentId: "main",
  profileId: "development",
};

export function seedStartingPlacement(
  store: PlacementStore,
  environmentId: string,
): WorkerSessionPlacementRecord {
  let current = store.startDispatch(REQUEST);
  current = store.transition({
    sessionId: REQUEST.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: current.generation,
    patch: { environmentId },
  });
  current = store.transition({
    sessionId: REQUEST.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: current.generation,
    patch: { workerBundleHash: BUNDLE_HASH },
  });
  current = store.transition({
    sessionId: REQUEST.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: current.generation,
    patch: {
      workspaceBaseManifestRef: MANIFEST_REF,
      remoteWorkspaceDir: "/worker/workspace",
    },
  });
  return current;
}

export function seedActivePlacement(
  store: PlacementStore,
  params: { environmentId: string; ownerEpoch: number },
): WorkerSessionPlacementRecord {
  const current = seedStartingPlacement(store, params.environmentId);
  return store.transition({
    sessionId: REQUEST.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: current.generation,
    patch: { activeOwnerEpoch: params.ownerEpoch },
  });
}

export function createDispatchEnvironmentFixtures() {
  const environmentId = workerEnvironmentIdForIdempotencyKey(
    `session-dispatch:${REQUEST.sessionId}:1`,
  );
  const profileSnapshot: WorkerProfile = { settings: { region: "test" } };
  const bootstrapReceipt: WorkerAdmissionHandshake = {
    bundleHash: BUNDLE_HASH,
    openclawVersion: "2026.7.2",
    protocolFeatures: [WORKER_LAUNCH_V2_PROTOCOL_FEATURE],
  };
  const sshEndpoint: WorkerSshEndpoint = {
    host: "worker.example.test",
    port: 22,
    user: "worker",
    hostKey: [["ssh", "ed25519"].join("-"), "AAAA"].join(" "),
    keyRef: { source: "file", provider: "worker-keys", id: "/key" },
  };
  const environmentBase = {
    environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot,
    provisionOperationId: "provision-1",
    bootstrapReceipt,
    teardownTerminalState: null,
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    leaseId: "lease-1",
    sshEndpoint,
  };
  const ready = {
    ...environmentBase,
    state: "ready",
    ownerEpoch: 1,
    attachedSessionIds: [],
    tunnelStatus: "connected",
  } satisfies DispatchEnvironmentRecord;
  const attached = {
    ...environmentBase,
    state: "attached",
    ownerEpoch: 2,
    attachedSessionIds: [REQUEST.sessionId],
    tunnelStatus: "connected",
  } satisfies DispatchEnvironmentRecord;
  const destroyedEnvironment = (ownerEpoch: number): DispatchEnvironmentRecord => ({
    ...environmentBase,
    state: "destroyed",
    ownerEpoch,
    attachedSessionIds: [],
    tunnelStatus: "stopped",
  });
  return { attached, destroyedEnvironment, environmentId, ready };
}
