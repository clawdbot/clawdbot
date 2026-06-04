// Tracks plugin HTTP registry context for current async execution.
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizePluginHttpPath } from "./http-path.js";
import { findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { requireActivePluginHttpRouteRegistry } from "./runtime.js";

export type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

const pluginHttpRouteRegistryScope = new AsyncLocalStorage<PluginRegistry>();

export function withPluginHttpRouteRegistry<T>(registry: PluginRegistry, run: () => T): T {
  return pluginHttpRouteRegistryScope.run(registry, run);
}

export function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  auth: PluginHttpRouteRegistration["auth"];
  match?: PluginHttpRouteRegistration["match"];
  gatewayRuntimeScopeSurface?: PluginHttpRouteRegistration["gatewayRuntimeScopeSurface"];
  replaceExisting?: boolean;
  pluginId?: string;
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
}): () => void {
  const registry =
    params.registry ??
    pluginHttpRouteRegistryScope.getStore() ??
    requireActivePluginHttpRouteRegistry();
  const routes = registry.httpRoutes ?? [];
  registry.httpRoutes = routes;

  const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
  const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
  if (!normalizedPath) {
    params.log?.(`plugin: webhook path missing${suffix}`);
    return () => {};
  }

  const routeMatch = params.match ?? "exact";
  const overlappingRoute = findOverlappingPluginHttpRoute(routes, {
    path: normalizedPath,
    match: routeMatch,
  });
  if (overlappingRoute && overlappingRoute.auth !== params.auth) {
    params.log?.(
      `plugin: route overlap denied at ${normalizedPath} (${routeMatch}, ${params.auth})${suffix}; ` +
        `overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) ` +
        `owned by ${overlappingRoute.pluginId ?? "unknown-plugin"} (${overlappingRoute.source ?? "unknown-source"})`,
    );
    return () => {};
  }
  const existingIndex = routes.findIndex(
    (entry) => entry.path === normalizedPath && entry.match === routeMatch,
  );
  if (existingIndex >= 0) {
    const existing = routes[existingIndex];
    if (!existing) {
      return () => {};
    }
    if (!params.replaceExisting) {
      params.log?.(
        `plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId ?? "unknown-plugin"} (${existing.source ?? "unknown-source"})`,
      );
      return () => {};
    }
    if (existing.pluginId && params.pluginId && existing.pluginId !== params.pluginId) {
      params.log?.(
        `plugin: route replacement denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId}`,
      );
      return () => {};
    }
    const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
    params.log?.(
      `plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`,
    );
    routes.splice(existingIndex, 1);
  }

  const entry: PluginHttpRouteRegistration = {
    path: normalizedPath,
    handler: params.handler,
    auth: params.auth,
    match: routeMatch,
    ...(params.gatewayRuntimeScopeSurface
      ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
      : {}),
    pluginId: params.pluginId,
    source: params.source,
  };
  routes.push(entry);

  return () => {
    const index = routes.indexOf(entry);
    if (index >= 0) {
      routes.splice(index, 1);
    }
  };
}
