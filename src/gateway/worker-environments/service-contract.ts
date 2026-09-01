import { createHash } from "node:crypto";
import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type {
  WorkerDesktopApp,
  WorkerMachineOption,
  WorkerProfile,
} from "../../plugins/capability-provider.types.js";
import type {
  WorkerPlacementMoveSource,
  WorkerPlacementMoveTarget,
} from "./placement-move-intent.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerPlacementExecutionMode,
} from "./placement-record.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerTunnelHandle,
  WorkerTunnelRequest,
  WorkerTunnelStatus,
} from "./tunnel-contract.js";

export function deriveEnvironmentIntent(idempotencyKey: string): {
  environmentId: string;
  provisionOperationId: string;
} {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return {
    environmentId: `worker:${digest.slice(0, 32)}`,
    provisionOperationId: `provision:v2:${digest}`,
  };
}

/** Non-secret worker projection available to Gateway request handlers. */
export type WorkerEnvironmentServiceRecord = {
  environmentId: string;
  providerId: string;
  profileId: string;
  leaseId: string | null;
  nodeDeviceId?: string | null;
  sharedHost: boolean | null;
  state: WorkerEnvironmentState;
  ownerEpoch: number;
  createdAtMs: number;
  idleSinceAtMs: number | null;
  attachedSessionIds: readonly string[];
  desktopAvailable: boolean;
  desktopApps: readonly WorkerDesktopApp["id"][];
  tunnelStatus: WorkerTunnelStatus;
  error?: string;
};

export type WorkerDesktopObserveResult = {
  transport: "rfb";
  wsPath: string;
  expiresAtMs: number;
  control: boolean;
  vncPassword?: string;
};

export type WorkerDesktopLaunchResult = {
  app: WorkerDesktopApp["id"];
  status: "ready";
};

/** Request-facing lifecycle methods, kept separate from persistence and provider internals. */
export type WorkerEnvironmentServiceContract = {
  list(): WorkerEnvironmentServiceRecord[];
  get(environmentId: string): WorkerEnvironmentServiceRecord | undefined;
  inventoryVersion(): number;
  supportsExecutionMode?(profileId: string, mode: WorkerPlacementExecutionMode): boolean;
  listMachineOptions(profileId: string): Promise<readonly WorkerMachineOption[] | undefined>;
  create(
    profileId: string,
    idempotencyKey: string,
    machineClass?: string,
    executionMode?: WorkerPlacementExecutionMode,
  ): Promise<WorkerEnvironmentServiceRecord>;
  destroy(environmentId: string): Promise<WorkerEnvironmentServiceRecord>;
  destroyUnattached(environmentId: string): Promise<WorkerEnvironmentServiceRecord>;
  observeDesktop(request: {
    environmentId: string;
    control: boolean;
  }): Promise<WorkerDesktopObserveResult>;
  launchDesktopApp(request: {
    environmentId: string;
    app: WorkerDesktopApp["id"];
  }): Promise<WorkerDesktopLaunchResult>;
  startTunnel(request: WorkerTunnelRequest): Promise<WorkerTunnelHandle>;
  stopTunnel(environmentId: string, ownerEpoch?: number): Promise<void>;
};

export type WorkerPlacementDispatchRequest = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  profileId: string;
  executionMode: WorkerPlacementExecutionMode;
  devicePlacement?: DevicePlacementRequirement;
  idempotencyKey?: string;
  deviceId?: string;
  machineClass?: string;
  inheritedProfile?: {
    providerId: string;
    profileSnapshot: WorkerProfile;
  };
};

export type WorkerPlacementDispatchAdmission = <T>(
  request: Pick<WorkerPlacementDispatchRequest, "sessionId" | "sessionKey" | "agentId">,
  run: (signal?: AbortSignal) => Promise<T>,
  authorize?: () => void,
) => Promise<T>;

/** Canonical admission rejected the session owner, not a caller or process cancellation. */
export class WorkerPlacementAdmissionTargetError extends Error {
  readonly code = "invalid_state";
}

export type WorkerPlacementMoveDestination = Pick<
  WorkerPlacementDispatchRequest,
  | "profileId"
  | "executionMode"
  | "devicePlacement"
  | "deviceId"
  | "machineClass"
  | "inheritedProfile"
>;

export type WorkerPlacementReclaimRequest = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
};

export type WorkerPlacementMoveRequest = WorkerPlacementReclaimRequest & {
  source: WorkerPlacementMoveSource;
  target: WorkerPlacementMoveTarget;
  abandonSource?: true;
};

/** Closure-bound request authority; in-process only and never part of durable placement intent. */
export type WorkerPlacementAuthorization = () => void;

// Leaf dispatch contract: GatewayRequestContext must not import the dispatch
// runtime (it reaches agents/plugins and closes an import cycle through core).
export type WorkerPlacementDispatchContract = {
  dispatch(
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerSessionPlacementRecord) => void,
    authorize?: WorkerPlacementAuthorization,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>>;
  move?(
    request: WorkerPlacementMoveRequest,
    onTransition?: (placement: WorkerSessionPlacementRecord) => void,
    authorize?: WorkerPlacementAuthorization,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "local" | "active" }>>;
  reclaim?(
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementAuthorization,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "local" | "reclaimed" }>>;
  forceDestroyEnvironment?(
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ): Promise<WorkerEnvironmentServiceRecord>;
  reconcileActive?(environmentId?: string): Promise<void>;
};
