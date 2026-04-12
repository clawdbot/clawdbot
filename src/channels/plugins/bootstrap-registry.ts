import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { listBundledChannelPluginIds } from "./bundled-ids.js";
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

let cachedBootstrapPlugins: CachedBootstrapPlugins | null = null;

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

function buildBootstrapPlugins(): CachedBootstrapPlugins {
  return {
    sortedIds: listBundledChannelPluginIds(),
    byId: new Map(),
    secretsById: new Map(),
    missingIds: new Set(),
  };
}

function getBootstrapPlugins(): CachedBootstrapPlugins {
  cachedBootstrapPlugins ??= buildBootstrapPlugins();
  return cachedBootstrapPlugins;
}

export function listBootstrapChannelPluginIds(): readonly string[] {
  return getBootstrapPlugins().sortedIds;
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
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  const registry = getBootstrapPlugins();
  const cached = registry.byId.get(resolvedId);
  if (cached) {
    return cached;
  }
  if (registry.missingIds.has(resolvedId)) {
    return undefined;
  }
  const runtimePlugin = getBundledChannelPlugin(resolvedId);
  const setupPlugin = getBundledChannelSetupPlugin(resolvedId);
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
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  const registry = getBootstrapPlugins();
  const cached = registry.secretsById.get(resolvedId);
  if (cached) {
    return cached;
  }
  if (registry.secretsById.has(resolvedId)) {
    return undefined;
  }
  const runtimeSecrets = getBundledChannelSecrets(resolvedId);
  const setupSecrets = getBundledChannelSetupSecrets(resolvedId);
  const merged = mergePluginSection(runtimeSecrets, setupSecrets);
  registry.secretsById.set(resolvedId, merged ?? null);
  return merged;
}

export function clearBootstrapChannelPluginCache(): void {
  cachedBootstrapPlugins = null;
}
