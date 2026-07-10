// Plugin HTTP routing dispatches registered plugin routes, upgrades, auth policy, and runtime request scope.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/index.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "../../plugins/registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { AuthorizedGatewayHttpRequest } from "../http-utils.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "../server-methods/types.js";
import { resolvePluginRouteRuntimeOperatorScopes } from "./plugin-route-runtime-scopes.js";
import {
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./plugins-http/path-context.js";
import { matchedPluginRoutesRequireGatewayAuth } from "./plugins-http/route-auth.js";
import { findMatchingPluginHttpRoutes } from "./plugins-http/route-match.js";

export {
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./plugins-http/path-context.js";
export {
  findRegisteredPluginHttpRoute,
  isRegisteredPluginHttpRoutePath,
} from "./plugins-http/route-match.js";
export { shouldEnforceGatewayAuthForPluginPath } from "./plugins-http/route-auth.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;
type PluginRouteRuntimeScope = Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

function resolvePluginRoutePathContextForRequest(
  req: IncomingMessage,
  providedPathContext: PluginRoutePathContext | undefined,
): PluginRoutePathContext {
  if (providedPathContext) {
    return providedPathContext;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  return resolvePluginRoutePathContext(url.pathname);
}

function createPluginRouteRuntimeClient(
  scopes: readonly string[],
  clientIp: string | undefined,
): GatewayRequestOptions["client"] {
  return {
    connId: `plugin-http:${clientIp ?? "unknown"}`,
    ...(clientIp ? { clientIp } : {}),
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: "internal",
        platform: "node",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes: [...scopes],
    },
  };
}

function writeUpgradeUnauthorized(socket: Duplex) {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

type PluginRouteRuntimeDispatchContext = {
  gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
  gatewayRequestOperatorScopes?: readonly string[];
  gatewayRequestClientIp?: string;
};

function getMissingPluginRouteRuntimeContext(
  route: PluginHttpRouteRegistration,
  context: PluginRouteRuntimeDispatchContext,
): "caller auth context" | "caller scope context" | undefined {
  if (route.auth !== "gateway") {
    return undefined;
  }
  if (route.gatewayRuntimeScopeSurface === "trusted-operator") {
    return context.gatewayRequestAuth ? undefined : "caller auth context";
  }
  return context.gatewayRequestOperatorScopes === undefined ? "caller scope context" : undefined;
}

function createPluginRouteRuntimeScope(params: {
  route: PluginHttpRouteRegistration;
  req: IncomingMessage;
  gatewayRequestContext?: GatewayRequestContext;
  gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
  gatewayRequestOperatorScopes?: readonly string[];
  gatewayRequestClientIp?: string;
}): PluginRouteRuntimeScope {
  const runtimeScopes =
    params.route.auth !== "gateway"
      ? []
      : params.route.gatewayRuntimeScopeSurface === "trusted-operator"
        ? resolvePluginRouteRuntimeOperatorScopes(
            params.req,
            params.gatewayRequestAuth!,
            "trusted-operator",
          )
        : params.gatewayRequestOperatorScopes!;
  const runtimeClient = createPluginRouteRuntimeClient(
    runtimeScopes,
    params.gatewayRequestClientIp,
  );
  return {
    ...(params.gatewayRequestContext ? { context: params.gatewayRequestContext } : {}),
    client: runtimeClient,
    isWebchatConnect: () => false,
    ...(params.route.pluginId ? { pluginId: params.route.pluginId } : {}),
    ...(params.route.source ? { pluginSource: params.route.source } : {}),
    ...(params.route.gatewayMethodDispatchAllowed === true
      ? { gatewayMethodDispatchAllowed: true }
      : {}),
  };
}

export type PluginRouteDispatchContext = {
  gatewayAuthSatisfied?: boolean;
  gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
  gatewayRequestOperatorScopes?: readonly string[];
  gatewayRequestClientIp?: string;
};

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginRouteDispatchContext,
) => Promise<boolean>;

export type PluginHttpUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginRouteDispatchContext,
) => Promise<boolean>;

export function createGatewayPluginRequestHandler(params: {
  registry: PluginRegistry;
  getRouteRegistry?: () => PluginRegistry;
  log: SubsystemLogger;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
}): PluginHttpRequestHandler {
  const { log } = params;
  return async (req, res, providedPathContext, dispatchContext) => {
    const registry = params.getRouteRegistry?.() ?? params.registry;
    const gatewayRequestContext = params.getGatewayRequestContext?.();
    const routes = registry.httpRoutes ?? [];
    if (routes.length === 0) {
      return false;
    }

    const pathContext = resolvePluginRoutePathContextForRequest(req, providedPathContext);
    const matchedRoutes = findMatchingPluginHttpRoutes(registry, pathContext);
    if (matchedRoutes.length === 0) {
      return false;
    }
    const requiresGatewayAuth = matchedPluginRoutesRequireGatewayAuth(matchedRoutes);
    if (requiresGatewayAuth && dispatchContext?.gatewayAuthSatisfied !== true) {
      log.warn(`plugin http route blocked without gateway auth (${pathContext.canonicalPath})`);
      return false;
    }
    const gatewayRequestAuth = dispatchContext?.gatewayRequestAuth;
    const gatewayRequestOperatorScopes = dispatchContext?.gatewayRequestOperatorScopes;

    // Fail closed before invoking any handlers when matched gateway routes are
    // missing the runtime auth/scope context they require.
    for (const route of matchedRoutes) {
      const missingRuntimeContext = getMissingPluginRouteRuntimeContext(route, {
        gatewayRequestAuth,
        gatewayRequestOperatorScopes,
      });
      if (missingRuntimeContext) {
        log.warn(
          `plugin http route blocked without ${missingRuntimeContext} (${pathContext.canonicalPath})`,
        );
        return false;
      }
    }

    for (const route of matchedRoutes) {
      try {
        const handled = await withPluginRuntimeGatewayRequestScope(
          createPluginRouteRuntimeScope({
            route,
            req,
            gatewayRequestContext,
            gatewayRequestAuth,
            gatewayRequestOperatorScopes,
            gatewayRequestClientIp: dispatchContext?.gatewayRequestClientIp,
          }),
          async () => route.handler(req, res),
        );
        if (handled !== false) {
          return true;
        }
      } catch (err) {
        log.warn(`plugin http route failed (${route.pluginId ?? "unknown"}): ${String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Internal Server Error");
        } else if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return true;
      }
    }
    return false;
  };
}

export function createGatewayPluginUpgradeHandler(params: {
  registry: PluginRegistry;
  getRouteRegistry?: () => PluginRegistry;
  log: SubsystemLogger;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
}): PluginHttpUpgradeHandler {
  const { log } = params;
  return async (req, socket, head, providedPathContext, dispatchContext) => {
    const registry = params.getRouteRegistry?.() ?? params.registry;
    const gatewayRequestContext = params.getGatewayRequestContext?.();
    const routes = registry.httpRoutes ?? [];
    if (routes.length === 0) {
      return false;
    }

    const pathContext = resolvePluginRoutePathContextForRequest(req, providedPathContext);
    const matchedRoutes = findMatchingPluginHttpRoutes(registry, pathContext).filter(
      (route) => typeof route.handleUpgrade === "function",
    );
    if (matchedRoutes.length === 0) {
      return false;
    }
    const requiresGatewayAuth = matchedPluginRoutesRequireGatewayAuth(matchedRoutes);
    if (requiresGatewayAuth && dispatchContext?.gatewayAuthSatisfied !== true) {
      log.warn(`plugin http upgrade blocked without gateway auth (${pathContext.canonicalPath})`);
      writeUpgradeUnauthorized(socket);
      return true;
    }
    const gatewayRequestAuth = dispatchContext?.gatewayRequestAuth;
    const gatewayRequestOperatorScopes = dispatchContext?.gatewayRequestOperatorScopes;

    for (const route of matchedRoutes) {
      const missingRuntimeContext = getMissingPluginRouteRuntimeContext(route, {
        gatewayRequestAuth,
        gatewayRequestOperatorScopes,
      });
      if (missingRuntimeContext) {
        log.warn(
          `plugin http upgrade blocked without ${missingRuntimeContext} (${pathContext.canonicalPath})`,
        );
        writeUpgradeUnauthorized(socket);
        return true;
      }
    }

    for (const route of matchedRoutes) {
      try {
        const handled = await withPluginRuntimeGatewayRequestScope(
          createPluginRouteRuntimeScope({
            route,
            req,
            gatewayRequestContext,
            gatewayRequestAuth,
            gatewayRequestOperatorScopes,
            gatewayRequestClientIp: dispatchContext?.gatewayRequestClientIp,
          }),
          async () => route.handleUpgrade?.(req, socket, head),
        );
        if (handled !== false) {
          return true;
        }
      } catch (err) {
        log.warn(`plugin http upgrade failed (${route.pluginId ?? "unknown"}): ${String(err)}`);
        socket.destroy();
        return true;
      }
    }
    return false;
  };
}
