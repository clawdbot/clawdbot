import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementMoveRequest,
} from "./service-contract.js";

type DispatchService = WorkerPlacementDispatchService;

export function admittedRecovery(
  run: (
    placement: Parameters<DispatchService["resumeProvisioning"]>[0],
    core: Parameters<DispatchService["resumeProvisioning"]>[1],
  ) => Promise<void>,
): DispatchService["resumeProvisioning"] {
  return async (placement, core, _onTransition, admit) => {
    if (!admit) {
      throw new Error("Recovery fixture requires the coordinator admission owner");
    }
    return await admit(async (signal) => {
      await run(placement, async () => await core(signal));
      return undefined;
    });
  };
}

export function preparedReclaim(run: () => Promise<unknown>) {
  return async (
    _request: unknown,
    _authorize: unknown,
    _beforeDrain: unknown,
    serialize: (operation: () => Promise<unknown>) => Promise<unknown>,
  ) => await serialize(run);
}

export const REQUEST: WorkerPlacementDispatchRequest = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  agentId: "main",
  profileId: "test",
  executionMode: "worker-turn",
};

export const MOVE_REQUEST: WorkerPlacementMoveRequest = {
  sessionId: REQUEST.sessionId,
  sessionKey: REQUEST.sessionKey,
  agentId: REQUEST.agentId,
  source: { generation: 4, environmentId: "worker-source", ownerEpoch: 7 },
  target: { kind: "gateway" },
};

export const LOCAL_PLACEMENT = {
  ...REQUEST,
  state: "local",
  generation: 1,
  turnClaim: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  stateChangedAtMs: 1,
  environmentId: null,
  activeOwnerEpoch: null,
  workspaceBaseManifestRef: null,
  remoteWorkspaceDir: null,
  workerBundleHash: null,
  lastTranscriptAckCursor: null,
  lastLiveEventAckCursor: null,
  recoveryError: null,
  terminalReason: null,
  terminalAtMs: null,
} satisfies WorkerDispatchPlacement;

export const PROVISIONING_PLACEMENT = {
  ...LOCAL_PLACEMENT,
  state: "provisioning",
  sessionId: "cloud",
  environmentId: "worker-cloud",
} satisfies Parameters<DispatchService["resumeProvisioning"]>[0];

export const ACTIVE_PLACEMENT = {
  ...LOCAL_PLACEMENT,
  state: "active",
  environmentId: "worker-active",
  activeOwnerEpoch: 1,
  workspaceBaseManifestRef: "manifest",
  remoteWorkspaceDir: "/worker/workspace",
  workerBundleHash: "bundle",
} satisfies Awaited<ReturnType<DispatchService["dispatch"]>>;

export function createCoordinatorTestService(overrides: Partial<DispatchService>): DispatchService {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected placement fixture operation");
  };
  return {
    dispatch: unexpected,
    move: unexpected,
    reclaim: unexpected,
    forceDestroyEnvironment: unexpected,
    reconcile: unexpected,
    reconcileActive: unexpected,
    resumeProvisioning: unexpected,
    ...overrides,
  };
}
