/** Loads capability providers through the canonical scoped plugin loader. */
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadOpenClawPluginsWithInternalOverrides } from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";

const log = createSubsystemLogger("plugins");

const CAPABILITY_VITEST_SHIM_ALIASES = [
  {
    subpath: "config-runtime",
    target: new URL("./capability-runtime-vitest-shims/config-runtime.ts", import.meta.url),
  },
  {
    subpath: "media-runtime",
    target: new URL("./capability-runtime-vitest-shims/media-runtime.ts", import.meta.url),
  },
  {
    subpath: "provider-onboard",
    target: new URL("../plugin-sdk/provider-onboard.ts", import.meta.url),
  },
  {
    subpath: "speech-core",
    target: new URL("./capability-runtime-vitest-shims/speech-core.ts", import.meta.url),
  },
] as const;

function buildVitestCapabilityShimAliasMap(): Record<string, string> {
  return Object.fromEntries(
    CAPABILITY_VITEST_SHIM_ALIASES.flatMap(({ subpath, target }) => {
      const targetPath = fileURLToPath(target);
      return [
        [`openclaw/plugin-sdk/${subpath}`, targetPath],
        [`@openclaw/plugin-sdk/${subpath}`, targetPath],
      ];
    }),
  );
}

function buildBundledCapabilityRuntimeConfig(
  pluginIds: readonly string[],
  env?: PluginLoadOptions["env"],
  config?: PluginLoadOptions["config"],
): NonNullable<PluginLoadOptions["config"]> {
  // Only the speech owner may opt into legacy global-disable compatibility before capture.
  if (config?.plugins?.enabled === false) {
    return config;
  }
  const enablementCompat = withBundledPluginEnablementCompat({
    config,
    pluginIds,
  });
  return (
    withBundledPluginVitestCompat({
      config: enablementCompat,
      pluginIds,
      env,
    }) ?? {}
  );
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
  const config = buildBundledCapabilityRuntimeConfig(params.pluginIds, env, params.config);
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
  const useVitestShims = Boolean(env.VITEST && params.pluginSdkResolution === "dist");

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
      preferBuiltPluginArtifacts: useVitestShims,
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
        ...(useVitestShims
          ? {
              aliasOverrides: buildVitestCapabilityShimAliasMap(),
              tryNative: false,
            }
          : {}),
      },
    },
  );
}
