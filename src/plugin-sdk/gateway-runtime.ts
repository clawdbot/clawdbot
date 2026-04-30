// Public gateway/client helpers for plugins that talk to the host gateway surface.

export * from "../gateway/channel-status-patches.js";
export { addGatewayClientOptions, callGatewayFromCli } from "../cli/gateway-rpc.js";
export type { GatewayRpcOpts } from "../cli/gateway-rpc.js";
export { isLoopbackHost } from "../gateway/net.js";
export {
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
} from "../gateway/node-command-policy.js";
export type { NodeSession } from "../gateway/node-registry.js";
export {
  respondUnavailableOnNodeInvokeError,
  safeParseJson,
} from "../gateway/server-methods/nodes.helpers.js";
export type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
export { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";
export { resolveGatewayAuth } from "../gateway/auth.js";
export { rawDataToString } from "../infra/ws.js";
export { GatewayClient } from "../gateway/client.js";
export { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
export {
  createOperatorApprovalsGatewayClient,
  withOperatorApprovalsGatewayClient,
} from "../gateway/operator-approvals-client.js";
export { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
export type { EventFrame } from "../gateway/protocol/index.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
