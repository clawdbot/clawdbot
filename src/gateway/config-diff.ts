// Config path diff helper used by gateway mutation diagnostics.
import { isDeepStrictEqual } from "node:util";
import * as talk from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPlainObject } from "../utils.js";

/** Return dotted config paths whose values differ between two config snapshots. */
export function diffConfigPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (prev === next) {
    return [];
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prevValue, nextValue, childPrefix);
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
      defaults: { sessionStore: config.agents?.defaults?.sessionStore },
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
): string[] {
  const changedPaths = diffConfigPaths(prevConfig, nextConfig);
  const boundaryPaths = diffConfigPaths(
    projectGatewayReloadBoundaries(prevConfig),
    projectGatewayReloadBoundaries(nextConfig),
  );
  // Preserve only startup/reload ownership boundaries hidden by whole-object
  // collapse without changing ordinary diff multiplicity or ordering.
  return [...changedPaths, ...boundaryPaths.filter((path) => !changedPaths.includes(path))];
}
