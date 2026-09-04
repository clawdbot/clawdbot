// Config path diff helper used by gateway mutation diagnostics.
import { isDeepStrictEqual } from "node:util";
import * as talk from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPlainObject } from "../utils.js";

/** Return dotted config paths whose values differ between two config snapshots. */
export function diffConfigPaths(
  prev: unknown,
  next: unknown,
  prefix = "",
  refinementPrefixes: readonly string[] = [],
): string[] {
  if (prev === next) {
    return [];
  }
  const hasNestedRefinement = refinementPrefixes.some((entry) =>
    prefix ? entry.startsWith(`${prefix}.`) : true,
  );
  // A missing parent normally collapses to one path. Registered boundaries must
  // survive that collapse so a narrow owner rule can still outrank its fallback.
  if (
    (isPlainObject(prev) && isPlainObject(next)) ||
    (hasNestedRefinement && (isPlainObject(prev) || isPlainObject(next)))
  ) {
    const prevRecord = isPlainObject(prev) ? prev : {};
    const nextRecord = isPlainObject(next) ? next : {};
    const keys = new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prevRecord[key];
      const nextValue = nextRecord[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prevValue, nextValue, childPrefix, refinementPrefixes);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays can contain object entries (for example agent bindings);
    // compare structurally so identical values are not reported as changed.
    if (isDeepStrictEqual(prev, next)) {
      return [];
    }
  }
  return [prefix || "<root>"];
}

function projectGatewayReloadBoundaries(config: OpenClawConfig) {
  return {
    talk: {
      provider: talk.resolveConfiguredTalkSpeechProviderId(config),
      realtime: { provider: talk.resolveConfiguredTalkRealtimeProviderId(config) },
    },
  };
}

/** Preserve declared reload boundaries and derived capability-owner changes. */
export function diffGatewayReloadPaths(
  prevConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
  reloadPrefixes: Iterable<string>,
): string[] {
  const changedPaths = diffConfigPaths(prevConfig, nextConfig, "", [...reloadPrefixes]);
  const boundaryPaths = diffConfigPaths(
    projectGatewayReloadBoundaries(prevConfig),
    projectGatewayReloadBoundaries(nextConfig),
  );
  // Effective Talk owners can change without an authored provider key changing.
  // Ordinary ownership boundaries are already preserved by the reload prefixes.
  return [...changedPaths, ...boundaryPaths.filter((path) => !changedPaths.includes(path))];
}
