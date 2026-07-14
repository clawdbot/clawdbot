import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerTunnelHandle,
  WorkerTunnelRequest,
  WorkerTunnelStatus,
} from "./tunnel-contract.js";

/** Non-secret worker projection available to Gateway request handlers. */
export type WorkerEnvironmentServiceRecord = {
  environmentId: string;
  providerId: string;
  leaseId: string | null;
  state: WorkerEnvironmentState;
  ownerEpoch: number;
  createdAtMs: number;
  idleSinceAtMs: number | null;
  attachedSessionIds: readonly string[];
  tunnelStatus: WorkerTunnelStatus;
};

/** Request-facing lifecycle methods, kept separate from persistence and provider internals. */
export type WorkerEnvironmentServiceContract = {
  list(): WorkerEnvironmentServiceRecord[];
  get(environmentId: string): WorkerEnvironmentServiceRecord | undefined;
  create(profileId: string, idempotencyKey: string): Promise<WorkerEnvironmentServiceRecord>;
  destroy(environmentId: string): Promise<WorkerEnvironmentServiceRecord>;
  startTunnel(request: WorkerTunnelRequest): Promise<WorkerTunnelHandle>;
  stopTunnel(environmentId: string, ownerEpoch?: number): Promise<void>;
};

export type WorkerPlacementDispatchRequest = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  profileId: string;
};

// Leaf dispatch contract: GatewayRequestContext must not import the dispatch
// runtime (it reaches agents/plugins and closes an import cycle through core).
export type WorkerPlacementDispatchContract = {
  dispatch(
    request: WorkerPlacementDispatchRequest,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>>;
};
