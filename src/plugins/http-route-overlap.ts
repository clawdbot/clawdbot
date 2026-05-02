import { canonicalizePathVariant } from "../gateway/security-path.js";
import type { OpenClawPluginHttpRouteMatch } from "./types.js";

type PluginHttpRouteLike = {
  path: string;
  match: OpenClawPluginHttpRouteMatch;
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

export function findOverlappingPluginHttpRoute<
  T extends {
    path: string;
    match: OpenClawPluginHttpRouteMatch;
  },
>(routes: readonly T[], candidate: PluginHttpRouteLike): T | undefined {
  return routes.find((route) => doPluginHttpRoutesOverlap(route, candidate));
}
