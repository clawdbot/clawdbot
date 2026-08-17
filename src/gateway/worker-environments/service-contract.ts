import { createHash } from "node:crypto";
import type {
  WorkerDesktopApp,
  WorkerMachineOption,
  WorkerProfile,
} from "../../plugins/capability-provider.types.js";
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
  leaseId: string | null;
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
  listMachineOptions(profileId: string): Promise<readonly WorkerMachineOption[] | undefined>;
  create(
    profileId: string,
    idempotencyKey: string,
    machineClass?: string,
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
  deviceId?: string;
  machineClass?: string;
  inheritedProfile?: {
    providerId: string;
    profileSnapshot: WorkerProfile;
  };
};

export type WorkerPlacementReclaimRequest = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
};

// Leaf dispatch contract: GatewayRequestContext must not import the dispatch
// runtime (it reaches agents/plugins and closes an import cycle through core).
export type WorkerPlacementDispatchContract = {
  dispatch(
    request: WorkerPlacementDispatchRequest,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>>;
  reclaim?(
    request: WorkerPlacementReclaimRequest,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "local" | "reclaimed" }>>;
  forceDestroyEnvironment?(
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ): Promise<WorkerEnvironmentServiceRecord>;
  reconcileActive?(environmentId?: string): Promise<void>;
};
