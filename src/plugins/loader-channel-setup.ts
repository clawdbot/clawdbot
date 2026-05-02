import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import type { PluginRuntime } from "./runtime/types.js";

function mergeChannelPluginSection<T>(
  baseValue: T | undefined,
  overrideValue: T | undefined,
): T | undefined {
  if (
    baseValue &&
    overrideValue &&
    typeof baseValue === "object" &&
    typeof overrideValue === "object"
  ) {
    const merged = {
      ...(baseValue as Record<string, unknown>),
    };
    for (const [key, value] of Object.entries(overrideValue as Record<string, unknown>)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    return {
      ...merged,
    } as T;
  }
  return overrideValue ?? baseValue;
}

export function mergeSetupRuntimeChannelPlugin(
  runtimePlugin: ChannelPlugin,
  setupPlugin: ChannelPlugin,
): ChannelPlugin {
  return {
    ...runtimePlugin,
    ...setupPlugin,
    meta: mergeChannelPluginSection(runtimePlugin.meta, setupPlugin.meta),
    capabilities: mergeChannelPluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
    commands: mergeChannelPluginSection(runtimePlugin.commands, setupPlugin.commands),
    doctor: mergeChannelPluginSection(runtimePlugin.doctor, setupPlugin.doctor),
    reload: mergeChannelPluginSection(runtimePlugin.reload, setupPlugin.reload),
    config: mergeChannelPluginSection(runtimePlugin.config, setupPlugin.config),
    setup: mergeChannelPluginSection(runtimePlugin.setup, setupPlugin.setup),
    messaging: mergeChannelPluginSection(runtimePlugin.messaging, setupPlugin.messaging),
    actions: mergeChannelPluginSection(runtimePlugin.actions, setupPlugin.actions),
    secrets: mergeChannelPluginSection(runtimePlugin.secrets, setupPlugin.secrets),
  } as ChannelPlugin;
}

export type BundledRuntimeChannelRegistration = {
  id?: string;
  loadChannelPlugin?: () => ChannelPlugin;
  loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

export function resolveBundledRuntimeChannelRegistration(
  moduleExport: unknown,
): BundledRuntimeChannelRegistration {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return {};
  }
  const entryRecord = resolved as {
    kind?: unknown;
    id?: unknown;
    loadChannelPlugin?: unknown;
    loadChannelSecrets?: unknown;
    setChannelRuntime?: unknown;
  };
  if (
    entryRecord.kind !== "bundled-channel-entry" ||
    typeof entryRecord.id !== "string" ||
    typeof entryRecord.loadChannelPlugin !== "function"
  ) {
    return {};
  }
  return {
    id: entryRecord.id,
    loadChannelPlugin: entryRecord.loadChannelPlugin as () => ChannelPlugin,
    ...(typeof entryRecord.loadChannelSecrets === "function"
      ? {
          loadChannelSecrets: entryRecord.loadChannelSecrets as () =>
            | ChannelPlugin["secrets"]
            | undefined,
        }
      : {}),
    ...(typeof entryRecord.setChannelRuntime === "function"
      ? {
          setChannelRuntime: entryRecord.setChannelRuntime as (runtime: PluginRuntime) => void,
        }
      : {}),
  };
}

export function loadBundledRuntimeChannelPlugin(params: {
  registration: BundledRuntimeChannelRegistration;
}): {
  plugin?: ChannelPlugin;
  loadError?: unknown;
} {
  if (typeof params.registration.loadChannelPlugin !== "function") {
    return {};
  }
  try {
    const loadedPlugin = params.registration.loadChannelPlugin();
    const loadedSecrets = params.registration.loadChannelSecrets?.();
    if (!loadedPlugin || typeof loadedPlugin !== "object") {
      return {};
    }
    const mergedSecrets = mergeChannelPluginSection(loadedPlugin.secrets, loadedSecrets);
    return {
      plugin: {
        ...loadedPlugin,
        ...(mergedSecrets !== undefined ? { secrets: mergedSecrets } : {}),
      },
    };
  } catch (err) {
    return { loadError: err };
  }
}

export function resolveSetupChannelRegistration(moduleExport: unknown): {
  plugin?: ChannelPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
  usesBundledSetupContract?: boolean;
  loadError?: unknown;
} {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return {};
  }
  const setupEntryRecord = resolved as {
    kind?: unknown;
    loadSetupPlugin?: unknown;
    loadSetupSecrets?: unknown;
    setChannelRuntime?: unknown;
  };
  if (
    setupEntryRecord.kind === "bundled-channel-setup-entry" &&
    typeof setupEntryRecord.loadSetupPlugin === "function"
  ) {
    try {
      const loadedPlugin = setupEntryRecord.loadSetupPlugin();
      const loadedSecrets =
        typeof setupEntryRecord.loadSetupSecrets === "function"
          ? (setupEntryRecord.loadSetupSecrets() as ChannelPlugin["secrets"] | undefined)
          : undefined;
      if (loadedPlugin && typeof loadedPlugin === "object") {
        const mergedSecrets = mergeChannelPluginSection(
          (loadedPlugin as ChannelPlugin).secrets,
          loadedSecrets,
        );
        return {
          plugin: {
            ...(loadedPlugin as ChannelPlugin),
            ...(mergedSecrets !== undefined ? { secrets: mergedSecrets } : {}),
          },
          usesBundledSetupContract: true,
          ...(typeof setupEntryRecord.setChannelRuntime === "function"
            ? {
                setChannelRuntime: setupEntryRecord.setChannelRuntime as (
                  runtime: PluginRuntime,
                ) => void,
              }
            : {}),
        };
      }
    } catch (err) {
      return { loadError: err };
    }
  }
  const setup = resolved as {
    plugin?: unknown;
  };
  if (!setup.plugin || typeof setup.plugin !== "object") {
    return {};
  }
  return {
    plugin: setup.plugin as ChannelPlugin,
  };
}

export function shouldLoadChannelPluginInSetupRuntime(params: {
  manifestChannels: string[];
  setupSource?: string;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  preferSetupRuntimeForChannelPlugins?: boolean;
}): boolean {
  if (!params.setupSource || params.manifestChannels.length === 0) {
    return false;
  }
  if (
    params.preferSetupRuntimeForChannelPlugins &&
    params.startupDeferConfiguredChannelFullLoadUntilAfterListen === true
  ) {
    return true;
  }
  return !params.manifestChannels.some((channelId) =>
    isChannelConfigured(params.cfg, channelId, params.env),
  );
}

export function channelPluginIdBelongsToManifest(params: {
  channelId: string | undefined;
  pluginId: string;
  manifestChannels: readonly string[];
}): boolean {
  if (!params.channelId) {
    return true;
  }
  return params.channelId === params.pluginId || params.manifestChannels.includes(params.channelId);
}
