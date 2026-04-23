import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { listBundledChannelPluginIdsForRoot } from "./bundled-ids.js";
import { resolveBundledChannelRootScope } from "./bundled-root.js";
import {
  getBundledChannelPlugin,
  getBundledChannelSecrets,
  getBundledChannelSetupPlugin,
  getBundledChannelSetupSecrets,
} from "./bundled.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

type CachedBootstrapPlugins = {
  sortedIds: string[];
  byId: Map<string, ChannelPlugin>;
  secretsById: Map<string, ChannelPlugin["secrets"] | null>;
  missingIds: Set<string>;
};

const cachedBootstrapPluginsByRoot = new Map<string, CachedBootstrapPlugins>();

function resolveBootstrapChannelId(id: ChannelId): string {
  return normalizeOptionalString(id) ?? "";
}

function mergePluginSection<T>(
  runtimeValue: T | undefined,
  setupValue: T | undefined,
): T | undefined {
  if (
    runtimeValue &&
    setupValue &&
    typeof runtimeValue === "object" &&
    typeof setupValue === "object"
  ) {
    const merged = {
      ...(runtimeValue as Record<string, unknown>),
    };
    for (const [key, value] of Object.entries(setupValue as Record<string, unknown>)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    return {
      ...merged,
    } as T;
  }
  return setupValue ?? runtimeValue;
}

function mergeBootstrapPlugin(
  runtimePlugin: ChannelPlugin,
  setupPlugin: ChannelPlugin,
): ChannelPlugin {
  return {
    ...runtimePlugin,
    ...setupPlugin,
    meta: mergePluginSection(runtimePlugin.meta, setupPlugin.meta),
    capabilities: mergePluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
    commands: mergePluginSection(runtimePlugin.commands, setupPlugin.commands),
    doctor: mergePluginSection(runtimePlugin.doctor, setupPlugin.doctor),
    reload: mergePluginSection(runtimePlugin.reload, setupPlugin.reload),
    config: mergePluginSection(runtimePlugin.config, setupPlugin.config),
    setup: mergePluginSection(runtimePlugin.setup, setupPlugin.setup),
    messaging: mergePluginSection(runtimePlugin.messaging, setupPlugin.messaging),
    actions: mergePluginSection(runtimePlugin.actions, setupPlugin.actions),
    secrets: mergePluginSection(runtimePlugin.secrets, setupPlugin.secrets),
  } as ChannelPlugin;
}

function buildBootstrapPlugins(
  cacheKey: string,
  env: NodeJS.ProcessEnv = process.env,
): CachedBootstrapPlugins {
  return {
    sortedIds: listBundledChannelPluginIdsForRoot(cacheKey, env),
    byId: new Map(),
    secretsById: new Map(),
    missingIds: new Set(),
  };
}

function getBootstrapPlugins(
  cacheKey = resolveBundledChannelRootScope().cacheKey,
  env: NodeJS.ProcessEnv = process.env,
): CachedBootstrapPlugins {
  const cached = cachedBootstrapPluginsByRoot.get(cacheKey);
  if (cached) {
    return cached;
  }
  const created = buildBootstrapPlugins(cacheKey, env);
  cachedBootstrapPluginsByRoot.set(cacheKey, created);
  return created;
}

function resolveActiveBootstrapPlugins(): CachedBootstrapPlugins {
  return getBootstrapPlugins(resolveBundledChannelRootScope().cacheKey);
}

export function listBootstrapChannelPluginIds(): readonly string[] {
  return resolveActiveBootstrapPlugins().sortedIds;
}

export function* iterateBootstrapChannelPlugins(): IterableIterator<ChannelPlugin> {
  for (const id of listBootstrapChannelPluginIds()) {
    const plugin = getBootstrapChannelPlugin(id);
    if (plugin) {
      yield plugin;
    }
  }
}

export function listBootstrapChannelPlugins(): readonly ChannelPlugin[] {
  return [...iterateBootstrapChannelPlugins()];
}

export function getBootstrapChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = resolveBootstrapChannelId(id);
  if (!resolvedId) {
    return undefined;
  }
  const registry = resolveActiveBootstrapPlugins();
  const cached = registry.byId.get(resolvedId);
  if (cached) {
    return cached;
  }
  if (registry.missingIds.has(resolvedId)) {
    return undefined;
  }
  let runtimePlugin: ChannelPlugin | undefined;
  let setupPlugin: ChannelPlugin | undefined;
  try {
    runtimePlugin = getBundledChannelPlugin(resolvedId);
    setupPlugin = getBundledChannelSetupPlugin(resolvedId);
  } catch {
    registry.missingIds.add(resolvedId);
    return undefined;
  }
  const merged =
    runtimePlugin && setupPlugin
      ? mergeBootstrapPlugin(runtimePlugin, setupPlugin)
      : (setupPlugin ?? runtimePlugin);
  if (!merged) {
    registry.missingIds.add(resolvedId);
    return undefined;
  }
  registry.byId.set(resolvedId, merged);
  return merged;
}

export function getBootstrapChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const resolvedId = resolveBootstrapChannelId(id);
  if (!resolvedId) {
    return undefined;
  }
  const registry = resolveActiveBootstrapPlugins();
  const cached = registry.secretsById.get(resolvedId);
  if (cached) {
    return cached;
  }
  if (registry.secretsById.has(resolvedId)) {
    return undefined;
  }
  if (registry.missingIds.has(resolvedId)) {
    registry.secretsById.set(resolvedId, null);
    return undefined;
  }
  try {
    const runtimeSecrets = getBundledChannelSecrets(resolvedId);
    const setupSecrets = getBundledChannelSetupSecrets(resolvedId);
    const merged = mergePluginSection(runtimeSecrets, setupSecrets);
    registry.secretsById.set(resolvedId, merged ?? null);
    return merged;
  } catch {
    registry.missingIds.add(resolvedId);
    registry.secretsById.set(resolvedId, null);
    return undefined;
  }
}

export function clearBootstrapChannelPluginCache(): void {
  cachedBootstrapPluginsByRoot.clear();
}
