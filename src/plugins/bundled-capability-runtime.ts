/** Loads capability providers through the canonical scoped plugin loader. */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadOpenClawPluginsWithInternalOverrides } from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";

const log = createSubsystemLogger("plugins");

function buildBundledCapabilityRuntimeConfig(
  pluginIds: readonly string[],
  config?: PluginLoadOptions["config"],
): NonNullable<PluginLoadOptions["config"]> {
  // Only the speech owner may opt into legacy global-disable compatibility before capture.
  if (config?.plugins?.enabled === false) {
    return config;
  }
  return withBundledPluginEnablementCompat({ config, pluginIds }) ?? {};
}

function createCapabilityRegistrationRuntime(
  config: NonNullable<PluginLoadOptions["config"]>,
): Pick<PluginRuntime, "config"> {
  return {
    config: {
      current: () => config,
      mutateConfigFile: async () => {
        throw new Error("Capability discovery cannot mutate plugin configuration.");
      },
      replaceConfigFile: async () => {
        throw new Error("Capability discovery cannot replace plugin configuration.");
      },
    },
  };
}

export function loadBundledCapabilityRuntimeRegistry(params: {
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
  config?: PluginLoadOptions["config"];
  pluginSdkResolution?: PluginSdkResolutionPreference;
  discovery?: PluginDiscoveryResult;
}) {
  const env = params.env ?? process.env;
  const config = buildBundledCapabilityRuntimeConfig(params.pluginIds, params.config);
  const discovery = params.discovery ?? discoverOpenClawPlugins({ env });
  const pluginIds = new Set(params.pluginIds);
  const manifestRegistry = loadPluginManifestRegistry({
    config,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const scopedManifestRegistry = {
    plugins: manifestRegistry.plugins.filter(
      (plugin) => plugin.origin === "bundled" && pluginIds.has(plugin.id),
    ),
    diagnostics: manifestRegistry.diagnostics,
  };
  return loadOpenClawPluginsWithInternalOverrides(
    {
      config,
      env,
      onlyPluginIds: [...params.pluginIds],
      pluginSdkResolution: params.pluginSdkResolution,
      cache: false,
      activate: false,
      // Channel setup entries cannot register providers; keep their runtime entry in discovery mode.
      channelPluginLoadIntent: "full",
      manifestRegistry: scopedManifestRegistry,
      logger: {
        info: (message) => log.info(message),
        warn: (message) => log.warn(message),
        error: (message) => log.error(message),
        debug: (message) => log.debug(message),
      },
    },
    {
      // Discovery needs the current config, but not the full host runtime graph. The registry
      // still supplies its scoped lazy methods around this narrow base runtime.
      runtime: createCapabilityRegistrationRuntime(config),
      moduleLoader: {
        installNativeSdkResolver: false,
        loaderFilename: import.meta.url,
      },
    },
  );
}
