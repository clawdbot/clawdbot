// Plugin HTTP route auth helpers decide when gateway auth must protect a plugin route path.
import type { PluginRegistry } from "../../../plugins/registry.js";
import {
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./path-context.js";
import { findMatchingPluginHttpRoutes } from "./route-match.js";

/**
 * Gateway-auth decisions for plugin HTTP routes.
 */
export function matchedPluginRoutesRequireGatewayAuth(
  routes: readonly Pick<NonNullable<PluginRegistry["httpRoutes"]>[number], "auth">[],
): boolean {
  return routes.some((route) => route.auth === "gateway");
}

/** Returns true when a plugin path must pass gateway auth before routing. */
export function shouldEnforceGatewayAuthForPluginPath(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
): boolean {
  const pathContext =
    typeof pathnameOrContext === "string"
      ? resolvePluginRoutePathContext(pathnameOrContext)
      : pathnameOrContext;
  if (pathContext.malformedEncoding || pathContext.decodePassLimitReached) {
    return true;
  }
  if (isProtectedPluginRoutePathFromContext(pathContext)) {
    return true;
  }
  return matchedPluginRoutesRequireGatewayAuth(findMatchingPluginHttpRoutes(registry, pathContext));
}
