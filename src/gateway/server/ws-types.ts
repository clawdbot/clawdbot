// Gateway WebSocket client types describe authenticated client state retained by the server.
import type { WebSocket } from "ws";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { PluginNodeCapabilityClient } from "../plugin-node-capability.js";

/**
 * Runtime WebSocket client state tracked by the gateway server.
 */
export type GatewayWsClient = PluginNodeCapabilityClient & {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  isDeviceTokenAuth?: boolean;
  usesSharedGatewayAuth: boolean;
  sharedGatewaySessionGeneration?: string;
  presenceKey?: string;
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
