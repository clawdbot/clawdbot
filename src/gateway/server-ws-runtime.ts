// WebSocket runtime adapter wires a built GatewayRequestContext into the lower
// level connection handler and shared gateway WebSocket plumbing.
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  attachGatewayWsConnectionHandler,
  type AttachGatewayWsConnectionHandlerParams,
} from "./server/ws-connection.js";

// Websocket runtime adapter wires the already-built GatewayRequestContext into
// the lower-level connection handler. This keeps startup context construction
// separate from per-connection websocket plumbing.
type GatewayWsRuntimeParams = Omit<
  AttachGatewayWsConnectionHandlerParams,
  "buildRequestContext" | "refreshHealthSnapshot"
> & {
  context: GatewayRequestContext;
};

/** Attaches websocket handlers for an already-created gateway request context. */
export function attachGatewayWsHandlers(params: GatewayWsRuntimeParams) {
  attachGatewayWsConnectionHandler({
    wss: params.wss,
    clients: params.clients,
    preauthConnectionBudget: params.preauthConnectionBudget,
    port: params.port,
    gatewayHost: params.gatewayHost,
    pluginSurfaceScheme: params.pluginSurfaceScheme,
    getPluginNodeCapabilities: params.getPluginNodeCapabilities,
    resolvedAuth: params.resolvedAuth,
    getResolvedAuth: params.getResolvedAuth,
    getRequiredSharedGatewaySessionGeneration: params.getRequiredSharedGatewaySessionGeneration,
    rateLimiter: params.rateLimiter,
    browserRateLimiter: params.browserRateLimiter,
    nodeReapprovalCoordinator: params.nodeReapprovalCoordinator,
    preauthHandshakeTimeoutMs: params.preauthHandshakeTimeoutMs,
    isStartupPending: params.isStartupPending,
    isControlUiDeviceAuthMigrationPending: params.isControlUiDeviceAuthMigrationPending,
    gatewayMethods: params.gatewayMethods,
    events: params.events,
    refreshHealthSnapshot: params.context.refreshHealthSnapshot,
    logGateway: params.logGateway,
    logHealth: params.logHealth,
    logWsControl: params.logWsControl,
    extraHandlers: params.extraHandlers,
    getMethodRegistry: params.getMethodRegistry,
    ...(params.workerConnectionService
      ? { workerConnectionService: params.workerConnectionService }
      : {}),
    broadcast: params.broadcast,
    buildRequestContext: () => params.context,
  });
}
