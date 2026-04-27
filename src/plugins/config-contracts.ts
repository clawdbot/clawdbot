import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { findBundledPluginMetadataById } from "./bundled-plugin-metadata.js";
import type { PluginManifestConfigContracts } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

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
  fallbackToBundledMetadata?: boolean;
  fallbackToBundledMetadataForResolvedBundled?: boolean;
  fallbackBundledPluginIds?: readonly string[];
  pluginIds: readonly string[];
}): ReadonlyMap<string, PluginConfigContractMetadata> {
  const matches = new Map<string, PluginConfigContractMetadata>();
  const pluginIds = [
    ...new Set(params.pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean)),
  ];
  if (pluginIds.length === 0) {
    return matches;
  }
  const fallbackBundledPluginIds = new Set(
    (params.fallbackBundledPluginIds ?? []).map((pluginId) => pluginId.trim()).filter(Boolean),
  );

  const resolvedPluginOrigins = new Map<string, PluginOrigin>();
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
    includeDisabled: true,
  });
  for (const plugin of registry.plugins) {
    if (!pluginIds.includes(plugin.id)) {
      continue;
    }
    resolvedPluginOrigins.set(plugin.id, plugin.origin);
    if (!plugin.configContracts) {
      continue;
    }
    matches.set(plugin.id, {
      origin: plugin.origin,
      configContracts: plugin.configContracts,
    });
  }

  if (params.fallbackToBundledMetadata ?? true) {
    for (const pluginId of pluginIds) {
      const existing = matches.get(pluginId);
      const shouldHydrateBundledMatch =
        existing &&
        !existing.configContracts.secretInputs &&
        ((params.fallbackToBundledMetadataForResolvedBundled && existing.origin === "bundled") ||
          fallbackBundledPluginIds.has(pluginId));
      if (shouldHydrateBundledMatch) {
        const bundled = findBundledPluginMetadataById(pluginId);
        if (bundled?.manifest.configContracts?.secretInputs) {
          matches.set(pluginId, {
            origin: fallbackBundledPluginIds.has(pluginId) ? "bundled" : existing.origin,
            configContracts: {
              ...bundled.manifest.configContracts,
              ...existing.configContracts,
              secretInputs: bundled.manifest.configContracts.secretInputs,
            },
          });
        }
        continue;
      }
      if (matches.has(pluginId)) {
        continue;
      }
      const resolvedOrigin = resolvedPluginOrigins.get(pluginId);
      if (
        resolvedOrigin &&
        !(params.fallbackToBundledMetadataForResolvedBundled && resolvedOrigin === "bundled") &&
        !fallbackBundledPluginIds.has(pluginId)
      ) {
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
  }

  return matches;
}
