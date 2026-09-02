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
    mcp: { apps: config.mcp?.apps },
    agents: {
      ownership: config.agents?.ownership,
      defaults: {
        mediaMaxMb: config.agents?.defaults?.mediaMaxMb,
        sessionStore: config.agents?.defaults?.sessionStore,
      },
      entries: config.agents?.entries,
    },
    session: {
      scope: config.session?.scope,
      store: config.session?.store,
    },
    talk: {
      provider: talk.resolveConfiguredTalkSpeechProviderId(config),
      realtime: { provider: talk.resolveConfiguredTalkRealtimeProviderId(config) },
    },
  };
}

/** Preserve startup-only restart boundaries hidden by whole-object config changes. */
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
  // Preserve only startup/reload ownership boundaries hidden by whole-object
  // collapse without changing ordinary diff multiplicity or ordering.
  return [...changedPaths, ...boundaryPaths.filter((path) => !changedPaths.includes(path))];
}
