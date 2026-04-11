import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { findBundledPluginMetadataById } from "./bundled-plugin-metadata.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestConfigContracts } from "./manifest.js";
import type { PluginOrigin } from "./types.js";

export type PluginConfigContractMatch = {
  path: string;
  value: unknown;
};

export type PluginConfigContractMetadata = {
  origin: PluginOrigin;
  configContracts: PluginManifestConfigContracts;
};

type TraversalState = {
  segments: string[];
  value: unknown;
};

function normalizePathPattern(pathPattern: string): string[] {
  return pathPattern
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function appendPathSegment(path: string, segment: string): string {
  if (!path) {
    return segment;
  }
  return /^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`;
}

export function collectPluginConfigContractMatches(params: {
  root: unknown;
  pathPattern: string;
}): PluginConfigContractMatch[] {
  const pattern = normalizePathPattern(params.pathPattern);
  if (pattern.length === 0) {
    return [];
  }

  let states: TraversalState[] = [{ segments: [], value: params.root }];
  for (const segment of pattern) {
    const nextStates: TraversalState[] = [];
    for (const state of states) {
      if (segment === "*") {
        if (Array.isArray(state.value)) {
          for (const [index, value] of state.value.entries()) {
            nextStates.push({
              segments: [...state.segments, String(index)],
              value,
            });
          }
          continue;
        }
        if (isRecord(state.value)) {
          for (const [key, value] of Object.entries(state.value)) {
            nextStates.push({
              segments: [...state.segments, key],
              value,
            });
          }
        }
        continue;
      }
      if (Array.isArray(state.value)) {
        const index = Number.parseInt(segment, 10);
        if (Number.isInteger(index) && index >= 0 && index < state.value.length) {
          nextStates.push({
            segments: [...state.segments, segment],
            value: state.value[index],
          });
        }
        continue;
      }
      if (!isRecord(state.value) || !Object.prototype.hasOwnProperty.call(state.value, segment)) {
        continue;
      }
      nextStates.push({
        segments: [...state.segments, segment],
        value: state.value[segment],
      });
    }
    states = nextStates;
    if (states.length === 0) {
      break;
    }
  }

  return states.map((state) => ({
    path: state.segments.reduce(appendPathSegment, ""),
    value: state.value,
  }));
}

export function resolvePluginConfigContractsById(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  pluginIds: readonly string[];
}): ReadonlyMap<string, PluginConfigContractMetadata> {
  const matches = new Map<string, PluginConfigContractMetadata>();
  const pluginIds = [
    ...new Set(params.pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean)),
  ];
  if (pluginIds.length === 0) {
    return matches;
  }

  const resolvedPluginIds = new Set<string>();
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
  });
  for (const plugin of registry.plugins) {
    if (!pluginIds.includes(plugin.id)) {
      continue;
    }
    resolvedPluginIds.add(plugin.id);
    if (!plugin.configContracts) {
      continue;
    }
    matches.set(plugin.id, {
      origin: plugin.origin,
      configContracts: plugin.configContracts,
    });
  }

  for (const pluginId of pluginIds) {
    if (matches.has(pluginId) || resolvedPluginIds.has(pluginId)) {
      continue;
    }
    const bundled = findBundledPluginMetadataById(pluginId);
    if (!bundled?.manifest.configContracts) {
      continue;
    }
    matches.set(pluginId, {
      origin: "bundled",
      configContracts: bundled.manifest.configContracts,
    });
  }

  return matches;
}
