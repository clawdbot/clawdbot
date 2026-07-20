// Gateway WebSocket client types describe authenticated client state retained by the server.
import type { WebSocket } from "ws";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { PluginNodeCapabilityClient } from "../plugin-node-capability.js";
import type { WorkerConnectionIdentity } from "../worker-environments/connection-identity.js";

export const GATEWAY_WS_CONNECTION_KIND_PROPERTY = "__openclawConnectionKind";
export const GATEWAY_WS_PREAUTH_BUDGET_PROPERTY = "__openclawPreauthBudget";
type GatewayWsConnectionKind = "gateway" | "worker";
export type GatewayIngressWebSocket = WebSocket & {
  [GATEWAY_WS_CONNECTION_KIND_PROPERTY]?: GatewayWsConnectionKind;
  [GATEWAY_WS_PREAUTH_BUDGET_PROPERTY]?: {
    release(clientIp: string | undefined): void;
  };
  __openclawPreauthBudgetClaimed?: boolean;
  __openclawPreauthBudgetKey?: string;
};

/**
 * Runtime WebSocket client state tracked by the gateway server.
 */
export type GatewayWsClient = PluginNodeCapabilityClient & {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  connectionKind?: GatewayWsConnectionKind;
  worker?: WorkerConnectionIdentity;
  isDeviceTokenAuth?: boolean;
  /** Client id verified against the server-approved device pairing record. */
  pairedClientId?: string;
  usesSharedGatewayAuth: boolean;
  sharedGatewaySessionGeneration?: string;
  presenceKey?: string;
  authenticatedUserId?: string;
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    hasAvatar: boolean;
    updatedAt: number;
  };
  clientIp?: string;
  internal?: {
    approvalRuntime?: boolean;
    agentRuntimeIdentity?: AgentRuntimeIdentity;
  };
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
  invalidated?: boolean;
  invalidatedReason?: string;
};

export const WS_HANDSHAKE_PHASES = [
  "tcp_accepted",
  "ws_upgrade_started",
  "auth_credentials_received",
  "auth_validated",
  "session_attached",
  "hello_payload_prepared",
  "ready",
] as const;

export type WsHandshakePhase = (typeof WS_HANDSHAKE_PHASES)[number];
