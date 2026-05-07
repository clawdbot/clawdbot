import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { resolveActivePluginHttpRouteRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { AuthorizedGatewayHttpRequest } from "../http-utils.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../protocol/client-info.js";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import type { GatewayRequestOptions } from "../server-methods/types.js";
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

function createPluginRouteRuntimeClient(
  scopes: readonly string[],
): GatewayRequestOptions["client"] {
  return {
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

export type PluginRouteDispatchContext = {
  gatewayAuthSatisfied?: boolean;
  gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
  gatewayRequestOperatorScopes?: readonly string[];
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
  log: SubsystemLogger;
}): PluginHttpRequestHandler {
  const { log } = params;
  return async (req, res, providedPathContext, dispatchContext) => {
    const registry = resolveActivePluginHttpRouteRegistry(params.registry);
    const routes = registry.httpRoutes ?? [];
    if (routes.length === 0) {
      return false;
    }

    const pathContext =
      providedPathContext ??
      (() => {
        const url = new URL(req.url ?? "/", "http://localhost");
        return resolvePluginRoutePathContext(url.pathname);
      })();
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
      if (route.auth !== "gateway") {
        continue;
      }
      if (route.gatewayRuntimeScopeSurface === "trusted-operator") {
        if (!gatewayRequestAuth) {
          log.warn(
            `plugin http route blocked without caller auth context (${pathContext.canonicalPath})`,
          );
          return false;
        }
        continue;
      }
      if (gatewayRequestOperatorScopes === undefined) {
        log.warn(
          `plugin http route blocked without caller scope context (${pathContext.canonicalPath})`,
        );
        return false;
      }
    }

    for (const route of matchedRoutes) {
      let runtimeScopes: readonly string[] = [];
      if (route.auth === "gateway") {
        if (route.gatewayRuntimeScopeSurface === "trusted-operator") {
          runtimeScopes = resolvePluginRouteRuntimeOperatorScopes(
            req,
            gatewayRequestAuth!,
            "trusted-operator",
          );
        } else {
          runtimeScopes = gatewayRequestOperatorScopes!;
        }
      }

      const runtimeClient = createPluginRouteRuntimeClient(runtimeScopes);
      try {
        const handled = await withPluginRuntimeGatewayRequestScope(
          {
            client: runtimeClient,
            isWebchatConnect: () => false,
          },
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
        }
        return true;
      }
    }
    return false;
  };
}

export function createGatewayPluginUpgradeHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginHttpUpgradeHandler {
  const { log } = params;
  return async (req, socket, head, providedPathContext, dispatchContext) => {
    const registry = resolveActivePluginHttpRouteRegistry(params.registry);
    const routes = registry.httpRoutes ?? [];
    if (routes.length === 0) {
      return false;
    }

    const pathContext =
      providedPathContext ??
      (() => {
        const url = new URL(req.url ?? "/", "http://localhost");
        return resolvePluginRoutePathContext(url.pathname);
      })();
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
      if (route.auth !== "gateway") {
        continue;
      }
      if (route.gatewayRuntimeScopeSurface === "trusted-operator") {
        if (!gatewayRequestAuth) {
          log.warn(
            `plugin http upgrade blocked without caller auth context (${pathContext.canonicalPath})`,
          );
          writeUpgradeUnauthorized(socket);
          return true;
        }
        continue;
      }
      if (gatewayRequestOperatorScopes === undefined) {
        log.warn(
          `plugin http upgrade blocked without caller scope context (${pathContext.canonicalPath})`,
        );
        writeUpgradeUnauthorized(socket);
        return true;
      }
    }

    for (const route of matchedRoutes) {
      let runtimeScopes: readonly string[] = [];
      if (route.auth === "gateway") {
        if (route.gatewayRuntimeScopeSurface === "trusted-operator") {
          runtimeScopes = resolvePluginRouteRuntimeOperatorScopes(
            req,
            gatewayRequestAuth!,
            "trusted-operator",
          );
        } else {
          runtimeScopes = gatewayRequestOperatorScopes!;
        }
      }

      const runtimeClient = createPluginRouteRuntimeClient(runtimeScopes);
      try {
        const handled = await withPluginRuntimeGatewayRequestScope(
          {
            client: runtimeClient,
            isWebchatConnect: () => false,
          },
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
