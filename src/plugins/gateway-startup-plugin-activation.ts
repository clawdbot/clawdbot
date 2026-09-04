import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { isBundledProviderCompatPlugin } from "./bundled-provider-compat.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import {
  blocksPluginStartup,
  hasConfiguredActivationPath,
  listManifestChannelIds,
  normalizePluginsConfigForInstalledIndex,
} from "./gateway-startup-plugin-config.js";
import type {
  ConfiguredGenerationProviderIds,
  ConfiguredVoiceProviderIds,
  ManifestRegistryLookup,
  NormalizedPluginsConfig,
} from "./gateway-startup-plugin-contracts.js";
import {
  manifestOwnsConfiguredModelProvider,
  manifestOwnsConfiguredSpeechProvider,
  manifestOwnsConfiguredWebSearchProvider,
} from "./gateway-startup-plugin-providers.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { manifestOwnsWorkerProvider } from "./worker-provider-manifest.js";

type PluginStartupActivationParams = {
  plugin: InstalledPluginIndexRecord;
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: { plugins: NormalizedPluginsConfig; rootConfig?: OpenClawConfig };
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

type GatewayStartupActivationParams = PluginStartupActivationParams & {
  manifest: PluginManifestRecord | undefined;
  requiredAgentHarnessRuntimes: ReadonlySet<string>;
  configuredWorkerProviderIds: ReadonlySet<string>;
  configuredSpeechProviderIds: ReadonlySet<string>;
  configuredWebSearchProviderIds: ReadonlySet<string>;
  configuredModelProviderIds: ReadonlySet<string>;
  configuredGenerationProviderIds: ConfiguredGenerationProviderIds;
  configuredVoiceProviderIds: ConfiguredVoiceProviderIds;
  configuredMemoryEmbeddingProviderIds: ReadonlySet<string>;
};

type StartupActivationPolicy =
  | "provider"
  | "implicit-external"
  | "worker"
  | "speech"
  | "root"
  | "harness"
  | "hook"
  | "tool";
type StartupContractKey =
  | keyof ConfiguredGenerationProviderIds
  | keyof ConfiguredVoiceProviderIds
  | "embeddingProviders";

export function addRequiredAgentHarnessPluginIds(
  target: Set<string>,
  params: {
    activationSourceConfig: OpenClawConfig;
    config: OpenClawConfig;
    index: InstalledPluginIndex;
    pluginsConfig: ReturnType<typeof normalizePluginsConfigForInstalledIndex>;
    activationSource: {
      plugins: ReturnType<typeof normalizePluginsConfigForInstalledIndex>;
      rootConfig?: OpenClawConfig;
    };
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): void {
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(params.activationSourceConfig, {
      includeImplicitRuntimePreferences: false,
    }),
  );
  if (requiredAgentHarnessRuntimes.size === 0) {
    return;
  }
  for (const plugin of params.index.plugins) {
    if (
      plugin.startup.agentHarnesses.some((runtime) => requiredAgentHarnessRuntimes.has(runtime)) &&
      passesPluginStartupPolicy({ ...params, plugin }, "harness")
    ) {
      target.add(plugin.pluginId);
    }
  }
}

function resolveStartupActivationState(
  params: PluginStartupActivationParams,
  autoEnabledReason?: string,
  applyBundledProviderCompat = false,
) {
  const config = applyBundledProviderCompat
    ? (withBundledPluginEnablementCompat({
        config: params.config,
        pluginIds: [params.plugin.pluginId],
        env: params.env,
        activation: "defaults",
      }) ?? params.config)
    : params.config;
  return resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    channelIds: params.plugin.contributions?.channels,
    config: applyBundledProviderCompat
      ? normalizePluginsConfig(config.plugins)
      : params.pluginsConfig,
    rootConfig: config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
    ...(autoEnabledReason ? { autoEnabledReason } : {}),
  });
}

function isProviderCompatStartupPolicy(policy: StartupActivationPolicy): boolean {
  return (
    policy === "provider" ||
    policy === "worker" ||
    policy === "speech" ||
    policy === "implicit-external"
  );
}

function hasExplicitHookPolicyConfig(
  entry: NormalizedPluginsConfig["entries"][string] | undefined,
): boolean {
  return (
    entry?.hooks?.allowConversationAccess === true ||
    entry?.hooks?.allowPromptInjection === true ||
    entry?.hooks?.timeoutMs !== undefined ||
    (entry?.hooks?.timeouts !== undefined && Object.keys(entry.hooks.timeouts).length > 0)
  );
}

function passesPluginStartupPolicy(
  params: PluginStartupActivationParams,
  policy: StartupActivationPolicy,
): boolean {
  const { activationSource, plugin, pluginsConfig } = params;
  // Bundled speech contracts remain available even when global plugin activation is disabled.
  if (
    (policy !== "speech" && (!pluginsConfig.enabled || !activationSource.plugins.enabled)) ||
    blocksPluginStartup({
      pluginId: plugin.pluginId,
      pluginsConfig,
      activationSourcePlugins: activationSource.plugins,
    })
  ) {
    return false;
  }
  if (
    policy === "harness" &&
    [pluginsConfig, activationSource.plugins].some(
      (config) => config.allow.length > 0 && !config.allow.includes(plugin.pluginId),
    )
  ) {
    return false;
  }
  const bundled = plugin.origin === "bundled";
  // Authored harness/root intent and speech ownership activate bundled owners without defaults.
  if (bundled && (policy === "harness" || policy === "speech" || policy === "root")) {
    return true;
  }
  // External config-path owners require authored trust; ambient matching alone must not start them.
  if (
    policy === "root" &&
    activationSource.plugins.allow.length > 0 &&
    !activationSource.plugins.allow.includes(plugin.pluginId)
  ) {
    return false;
  }
  const activationState = resolveStartupActivationState(
    params,
    policy === "worker" ? "cloud worker provider required" : undefined,
    isProviderCompatStartupPolicy(policy) &&
      isBundledProviderCompatPlugin({
        origin: plugin.origin,
        providers: plugin.contributions?.providers,
        contracts: plugin.contributions?.contracts,
      }),
  );
  if (!activationState.enabled) {
    return false;
  }
  if (policy === "harness" || policy === "implicit-external") {
    return true;
  }
  if (policy === "hook") {
    return (
      activationState.explicitlyEnabled ||
      hasExplicitHookPolicyConfig(activationSource.plugins.entries[plugin.pluginId])
    );
  }
  return bundled || activationState.explicitlyEnabled;
}

function manifestOwnsConfiguredContract(
  manifest: PluginManifestRecord | undefined,
  contractKey: StartupContractKey,
  configuredProviderIds: ReadonlySet<string>,
): boolean {
  return (
    configuredProviderIds.size > 0 &&
    (manifest?.contracts?.[contractKey] ?? []).some((providerId) => {
      const normalized = normalizeOptionalLowercaseString(providerId);
      return normalized ? configuredProviderIds.has(normalized) : false;
    })
  );
}

function manifestOwnsConfiguredContractGroup(
  manifest: PluginManifestRecord | undefined,
  configuredProviderIds: ConfiguredGenerationProviderIds | ConfiguredVoiceProviderIds,
): boolean {
  return Object.entries(configuredProviderIds).some(([contractKey, providerIds]) =>
    manifestOwnsConfiguredContract(manifest, contractKey as StartupContractKey, providerIds),
  );
}

// Earlier ownership wins; evaluating descriptors lazily preserves startup precedence and imports.
const GATEWAY_STARTUP_ACTIVATION_POLICIES: readonly {
  policy: StartupActivationPolicy;
  matches: (params: GatewayStartupActivationParams) => boolean;
}[] = [
  {
    policy: "harness",
    matches: ({ plugin, requiredAgentHarnessRuntimes }) =>
      plugin.startup.agentHarnesses.some((runtime) => requiredAgentHarnessRuntimes.has(runtime)),
  },
  {
    policy: "root",
    matches: ({ manifest, activationSource, config }) =>
      hasConfiguredActivationPath({ manifest, config: activationSource.rootConfig ?? config }),
  },
  {
    policy: "worker",
    matches: ({ manifest, configuredWorkerProviderIds }) =>
      manifestOwnsWorkerProvider(manifest, configuredWorkerProviderIds),
  },
  {
    policy: "speech",
    matches: ({ manifest, configuredSpeechProviderIds }) =>
      manifestOwnsConfiguredSpeechProvider({ manifest, configuredSpeechProviderIds }),
  },
  {
    policy: "implicit-external",
    matches: ({ manifest, configuredWebSearchProviderIds }) =>
      manifestOwnsConfiguredWebSearchProvider({ manifest, configuredWebSearchProviderIds }),
  },
  {
    policy: "provider",
    matches: ({ manifest, configuredModelProviderIds }) =>
      manifestOwnsConfiguredModelProvider({ manifest, configuredModelProviderIds }),
  },
  {
    policy: "provider",
    matches: ({ manifest, configuredGenerationProviderIds }) =>
      manifestOwnsConfiguredContractGroup(manifest, configuredGenerationProviderIds),
  },
  {
    policy: "provider",
    matches: ({ manifest, configuredVoiceProviderIds }) =>
      manifestOwnsConfiguredContractGroup(manifest, configuredVoiceProviderIds),
  },
  {
    policy: "implicit-external",
    matches: ({ manifest, configuredMemoryEmbeddingProviderIds }) =>
      manifestOwnsConfiguredContract(
        manifest,
        "embeddingProviders",
        configuredMemoryEmbeddingProviderIds,
      ),
  },
  {
    policy: "hook",
    matches: ({ activationSource, manifest, plugin }) =>
      manifest?.activation?.onCapabilities?.includes("hook") === true ||
      hasExplicitHookPolicyConfig(activationSource.plugins.entries[plugin.pluginId]),
  },
  {
    policy: "tool",
    // Tool factories execute synchronously while an agent surface is built. Load enabled owners
    // at the Gateway lifecycle boundary so a first concurrent turn cannot block control traffic.
    matches: ({ manifest }) => (manifest?.contracts?.tools?.length ?? 0) > 0,
  },
  {
    policy: "provider",
    matches: ({ manifest }) => (manifest?.contracts?.trustedToolPolicies?.length ?? 0) > 0,
  },
];

/** Evaluates manifest-owned startup surfaces in their original precedence order. */
export function canStartGatewayStartupPlugin(params: GatewayStartupActivationParams): boolean {
  return GATEWAY_STARTUP_ACTIVATION_POLICIES.some(
    ({ matches, policy }) => matches(params) && passesPluginStartupPolicy(params, policy),
  );
}

export function canStartConfiguredChannelPlugin(
  params: PluginStartupActivationParams & { manifestLookup: ManifestRegistryLookup },
): boolean {
  const { activationSource, config, manifestLookup, plugin, pluginsConfig } = params;
  if (
    !pluginsConfig.enabled ||
    pluginsConfig.deny.includes(plugin.pluginId) ||
    pluginsConfig.entries[plugin.pluginId]?.enabled === false
  ) {
    return false;
  }
  const explicitBundledChannelConfig =
    plugin.origin === "bundled" &&
    listManifestChannelIds(manifestLookup, plugin.pluginId).some((channelId) =>
      hasExplicitChannelConfig({
        config: activationSource.rootConfig ?? config,
        channelId,
      }),
    );
  if (
    pluginsConfig.allow.length > 0 &&
    !pluginsConfig.allow.includes(plugin.pluginId) &&
    !explicitBundledChannelConfig
  ) {
    return false;
  }
  if (plugin.origin === "bundled") {
    return true;
  }
  const activationState = resolveStartupActivationState(params);
  return activationState.enabled && activationState.explicitlyEnabled;
}
