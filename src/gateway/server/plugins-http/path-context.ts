// Plugin HTTP path context canonicalizes request paths for route matching and protected-route auth checks.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  PROTECTED_PLUGIN_ROUTE_PREFIXES,
  canonicalizePathForSecurity,
} from "../../security-path.js";

/**
 * Canonical path context for plugin HTTP route auth and matching.
 */
export type PluginRoutePathContext = {
  pathname: string;
  canonicalPath: string;
  candidates: string[];
  malformedEncoding: boolean;
  decodePassLimitReached: boolean;
  rawNormalizedPath: string;
};

function normalizeProtectedPrefix(prefix: string): string {
  const collapsed = normalizeLowercaseStringOrEmpty(prefix).replace(/\/{2,}/g, "/");
  if (collapsed.length <= 1) {
    return collapsed || "/";
  }
  return collapsed.replace(/\/+$/, "");
}

/** Matches a normalized path against an exact protected prefix boundary. */
export function prefixMatchPath(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`)
  );
}

const NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES =
  PROTECTED_PLUGIN_ROUTE_PREFIXES.map(normalizeProtectedPrefix);

/** Returns true when any decoded path candidate targets a protected route. */
export function isProtectedPluginRoutePathFromContext(context: PluginRoutePathContext): boolean {
  if (
    context.candidates.some((candidate) =>
      NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) =>
        prefixMatchPath(candidate, prefix),
      ),
    )
  ) {
    return true;
  }
  // An unresolved decode chain could still reveal a protected prefix on a later pass.
  // Require auth rather than treating an intentionally over-encoded route as public.
  if (context.decodePassLimitReached) {
    return true;
  }
  if (!context.malformedEncoding) {
    return false;
  }
  return NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) =>
    prefixMatchPath(context.rawNormalizedPath, prefix),
  );
}

/** Builds all security-relevant decoded path candidates for a request path. */
export function resolvePluginRoutePathContext(pathname: string): PluginRoutePathContext {
  const canonical = canonicalizePathForSecurity(pathname);
  return {
    pathname,
    canonicalPath: canonical.canonicalPath,
    candidates: canonical.candidates,
    malformedEncoding: canonical.malformedEncoding,
    decodePassLimitReached: canonical.decodePassLimitReached,
    rawNormalizedPath: canonical.rawNormalizedPath,
  };
}
