// Gateway request scope tracks request-local plugin runtime context across async work.
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginOrigin } from "../plugin-origin.types.js";

type PluginRuntimeGatewayRequestScope = {
  context?: GatewayRequestContext;
  client?: GatewayRequestOptions["client"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  pluginId?: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  gatewayMethodDispatchAllowed?: boolean;
};

type PluginRuntimePluginScope = {
  pluginId: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
};

const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGatewayRequestScope",
);

const pluginRuntimeGatewayRequestScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRuntimeGatewayRequestScope>
>(
  PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY,
  () => new AsyncLocalStorage<PluginRuntimeGatewayRequestScope>(),
);

/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
): T {
  return pluginRuntimeGatewayRequestScope.run(scope, run);
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginScope<T>(scope: PluginRuntimePluginScope, run: () => T): T {
  const current = pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = current
    ? { ...current, pluginId: scope.pluginId }
    : {
        pluginId: scope.pluginId,
        isWebchatConnect: () => false,
      };
  if (scope.pluginSource !== undefined) {
    scoped.pluginSource = scope.pluginSource;
  } else {
    delete scoped.pluginSource;
  }
  if (scope.pluginOrigin !== undefined) {
    scoped.pluginOrigin = scope.pluginOrigin;
  } else {
    delete scoped.pluginOrigin;
  }
  if (scope.pluginTrustedOfficialInstall !== undefined) {
    scoped.pluginTrustedOfficialInstall = scope.pluginTrustedOfficialInstall;
  } else {
    delete scoped.pluginTrustedOfficialInstall;
  }
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginIdScope<T>(pluginId: string, run: () => T): T {
  return withPluginRuntimePluginScope({ pluginId }, run);
}

/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export function getPluginRuntimeGatewayRequestScope():
  | PluginRuntimeGatewayRequestScope
  | undefined {
  return pluginRuntimeGatewayRequestScope.getStore();
}
