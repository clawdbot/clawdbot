// Plugin HTTP route matching orders registered exact and prefix routes against canonical path candidates.
import type { PluginRegistry } from "../../../plugins/registry.js";
import { canonicalizePathVariant } from "../../security-path.js";
import {
  prefixMatchPath,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./path-context.js";

/**
 * Plugin HTTP route matching against canonicalized request paths.
 */
type PluginHttpRouteEntry = NonNullable<PluginRegistry["httpRoutes"]>[number];

/** Returns true when a registered route matches any canonical request candidate. */
function doesPluginRouteMatchPath(
  route: Pick<PluginHttpRouteEntry, "path" | "match">,
  context: PluginRoutePathContext,
): boolean {
  const routeCanonicalPath = canonicalizePathVariant(route.path);
  if (route.match === "prefix") {
    return context.candidates.some((candidate) => prefixMatchPath(candidate, routeCanonicalPath));
  }
  return context.candidates.some((candidate) => candidate === routeCanonicalPath);
}

/** Returns true when a retiring generation's parked route snapshot still claims the request path. */
export function matchesDrainingPluginHttpRoutes(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): boolean {
  const draining = registry.drainingHttpRoutes;
  // An expired snapshot is indistinguishable from no successor arriving, so stop claiming the
  // path and let it fall through to the 404 a removed route should answer.
  if (!draining || Date.now() >= draining.expiresAt) {
    return false;
  }
  return draining.routes.some((route) => doesPluginRouteMatchPath(route, context));
}

/** Finds matching plugin routes with exact matches ordered before prefix matches. */
export function findMatchingPluginHttpRoutes(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginHttpRouteEntry[] {
  const routes = registry.httpRoutes ?? [];
  if (routes.length === 0) {
    return [];
  }
  const exactMatches: PluginHttpRouteEntry[] = [];
  const prefixMatches: PluginHttpRouteEntry[] = [];
  for (const route of routes) {
    if (!doesPluginRouteMatchPath(route, context)) {
      continue;
    }
    if (route.match === "prefix") {
      prefixMatches.push(route);
    } else {
      exactMatches.push(route);
    }
  }
  exactMatches.sort((a, b) => b.path.length - a.path.length);
  prefixMatches.sort((a, b) => b.path.length - a.path.length);
  return [...exactMatches, ...prefixMatches];
}

/** Returns the first registered plugin HTTP route for a raw request path. */
export function findRegisteredPluginHttpRoute(
  registry: PluginRegistry,
  pathname: string,
): PluginHttpRouteEntry | undefined {
  const pathContext = resolvePluginRoutePathContext(pathname);
  return findMatchingPluginHttpRoutes(registry, pathContext)[0];
}

/** Convenience predicate for checking whether a raw path is a plugin HTTP route. */
export function isRegisteredPluginHttpRoutePath(
  registry: PluginRegistry,
  pathname: string,
): boolean {
  return findRegisteredPluginHttpRoute(registry, pathname) !== undefined;
}
