// Gateway WebSocket client types describe authenticated client state retained by the server.
import type { WebSocket } from "ws";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/index.js";
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
  };
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
  invalidated?: boolean;
  invalidatedReason?: string;
};
