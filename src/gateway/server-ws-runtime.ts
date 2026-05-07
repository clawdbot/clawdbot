import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import {
  attachGatewayWsConnectionHandler,
  type GatewayWsSharedHandlerParams,
} from "./server/ws-connection.js";

type GatewayWsRuntimeParams = Omit<GatewayWsSharedHandlerParams, "refreshHealthSnapshot"> & {
  logGateway: ReturnType<typeof createSubsystemLogger>;
  logHealth: ReturnType<typeof createSubsystemLogger>;
  logWsControl: ReturnType<typeof createSubsystemLogger>;
  extraHandlers: GatewayRequestHandlers;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  context: GatewayRequestContext;
};

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
    preauthHandshakeTimeoutMs: params.preauthHandshakeTimeoutMs,
    isStartupPending: params.isStartupPending,
    gatewayMethods: params.gatewayMethods,
    events: params.events,
    refreshHealthSnapshot: params.context.refreshHealthSnapshot,
    logGateway: params.logGateway,
    logHealth: params.logHealth,
    logWsControl: params.logWsControl,
    extraHandlers: params.extraHandlers,
    broadcast: params.broadcast,
    buildRequestContext: () => params.context,
  });
}
