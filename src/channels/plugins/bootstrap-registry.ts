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

export function listBootstrapChannelPluginIds(): readonly string[] {
  const rootScope = resolveBundledChannelRootScope();
  return listBundledChannelPluginIdsForRoot(rootScope.cacheKey);
}

export function* iterateBootstrapChannelPlugins(): IterableIterator<ChannelPlugin> {
  for (const id of listBootstrapChannelPluginIds()) {
    const plugin = getBootstrapChannelPlugin(id);
    if (plugin) {
      yield plugin;
    }
  }
}

export function getBootstrapChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = resolveBootstrapChannelId(id);
  if (!resolvedId) {
    return undefined;
  }
  let runtimePlugin: ChannelPlugin | undefined;
  let setupPlugin: ChannelPlugin | undefined;
  try {
    runtimePlugin = getBundledChannelPlugin(resolvedId);
    setupPlugin = getBundledChannelSetupPlugin(resolvedId);
  } catch {
    return undefined;
  }
  const merged =
    runtimePlugin && setupPlugin
      ? mergeBootstrapPlugin(runtimePlugin, setupPlugin)
      : (setupPlugin ?? runtimePlugin);
  return merged;
}

export function getBootstrapChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const resolvedId = resolveBootstrapChannelId(id);
  if (!resolvedId) {
    return undefined;
  }
  try {
    const runtimeSecrets = getBundledChannelSecrets(resolvedId);
    const setupSecrets = getBundledChannelSetupSecrets(resolvedId);
    return mergePluginSection(runtimeSecrets, setupSecrets);
  } catch {
    return undefined;
  }
}
