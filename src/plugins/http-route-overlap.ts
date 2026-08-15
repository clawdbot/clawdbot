/** Detects conflicting plugin HTTP routes before Gateway registration accepts them. */
import { canonicalizePathVariant } from "../gateway/security-path.js";
import type { OpenClawPluginHttpRouteMatch } from "./types.js";

type PluginHttpRouteLike = {
  path: string;
  match: OpenClawPluginHttpRouteMatch;
};

type PluginHttpRouteRegistrationLike = PluginHttpRouteLike & {
  auth: string;
};

function prefixMatchPath(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`)
  );
}

function doPluginHttpRoutesOverlap(
  a: Pick<PluginHttpRouteLike, "path" | "match">,
  b: Pick<PluginHttpRouteLike, "path" | "match">,
): boolean {
  const aPath = canonicalizePathVariant(a.path);
  const bPath = canonicalizePathVariant(b.path);

  if (a.match === "exact" && b.match === "exact") {
    return aPath === bPath;
  }
  if (a.match === "prefix" && b.match === "prefix") {
    return prefixMatchPath(aPath, bPath) || prefixMatchPath(bPath, aPath);
  }

  const prefixRoute = a.match === "prefix" ? a : b;
  const exactRoute = a.match === "exact" ? a : b;
  return prefixMatchPath(
    canonicalizePathVariant(exactRoute.path),
    canonicalizePathVariant(prefixRoute.path),
  );
}

/** Resolves the collision classes shared by static and lifecycle route registration. */
export function findPluginHttpRouteRegistrationConflicts<T extends PluginHttpRouteRegistrationLike>(
  routes: readonly T[],
  candidate: PluginHttpRouteRegistrationLike,
): {
  authOverlap: T | undefined;
  canonicalMatches: T[];
} {
  const canonicalCandidatePath = canonicalizePathVariant(candidate.path);
  let authOverlap: T | undefined;
  const canonicalMatches: T[] = [];
  for (const route of routes) {
    if (
      !authOverlap &&
      route.auth !== candidate.auth &&
      doPluginHttpRoutesOverlap(route, candidate)
    ) {
      authOverlap = route;
    }
    if (
      route.match === candidate.match &&
      canonicalizePathVariant(route.path) === canonicalCandidatePath
    ) {
      canonicalMatches.push(route);
    }
  }
  return { authOverlap, canonicalMatches };
}
