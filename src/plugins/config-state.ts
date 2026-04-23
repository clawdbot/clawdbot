import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  createEffectiveEnableStateResolver,
  createPluginEnableStateResolver,
  resolveMemorySlotDecisionShared,
  resolvePluginActivationDecisionShared,
  toPluginActivationState,
  type PluginActivationConfigSourceLike,
  type PluginActivationSource,
  type PluginActivationStateLike,
} from "./config-activation-shared.js";
import {
  hasExplicitPluginConfig as hasExplicitPluginConfigShared,
  isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared,
  normalizePluginsConfigWithResolver,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { defaultSlotIdForKey } from "./slots.js";

export type { PluginActivationSource };
export type PluginActivationState = PluginActivationStateLike;

export type PluginActivationConfigSource = {
  plugins: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
} & PluginActivationConfigSourceLike<OpenClawConfig>;

export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

let bundledPluginAliasLookupCache: ReadonlyMap<string, string> | undefined;

const BUILT_IN_PLUGIN_ALIAS_FALLBACKS: ReadonlyArray<readonly [alias: string, pluginId: string]> = [
  ["openai-codex", "openai"],
  ["google-gemini-cli", "google"],
  ["minimax-portal", "minimax"],
  ["minimax-portal-auth", "minimax"],
] as const;

function getBundledPluginAliasLookup(): ReadonlyMap<string, string> {
  if (bundledPluginAliasLookupCache) {
    return bundledPluginAliasLookupCache;
  }

  const lookup = new Map<string, string>();
  for (const plugin of loadPluginManifestRegistry({ cache: true }).plugins) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    const pluginId = normalizeOptionalLowercaseString(plugin.id);
    if (pluginId) {
      lookup.set(pluginId, plugin.id);
    }
    for (const providerId of plugin.providers) {
      const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
      if (normalizedProviderId) {
        lookup.set(normalizedProviderId, plugin.id);
      }
    }
    for (const legacyPluginId of plugin.legacyPluginIds ?? []) {
      const normalizedLegacyPluginId = normalizeOptionalLowercaseString(legacyPluginId);
      if (normalizedLegacyPluginId) {
        lookup.set(normalizedLegacyPluginId, plugin.id);
      }
    }
  }
  for (const [alias, pluginId] of BUILT_IN_PLUGIN_ALIAS_FALLBACKS) {
    lookup.set(alias, pluginId);
  }
  bundledPluginAliasLookupCache = lookup;
  return lookup;
}

export function normalizePluginId(id: string): string {
  const trimmed = normalizeOptionalString(id) ?? "";
  const normalized = normalizeOptionalLowercaseString(trimmed) ?? "";
  return getBundledPluginAliasLookup().get(normalized) ?? trimmed;
}

export const normalizePluginsConfig = (
  config?: OpenClawConfig["plugins"],
): NormalizedPluginsConfig => {
  return normalizePluginsConfigWithResolver(config, normalizePluginId);
};

export function createPluginActivationSource(params: {
  config?: OpenClawConfig;
  plugins?: NormalizedPluginsConfig;
}): PluginActivationConfigSource {
  return {
    plugins: params.plugins ?? normalizePluginsConfig(params.config?.plugins),
    rootConfig: params.config,
  };
}

const hasExplicitMemorySlot = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(
    plugins?.entries &&
    Object.prototype.hasOwnProperty.call(plugins.entries, defaultSlotIdForKey("memory")),
  );

export const hasExplicitPluginConfig = (plugins?: OpenClawConfig["plugins"]) =>
  hasExplicitPluginConfigShared(plugins);

export function applyTestPluginDefaults(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!env.VITEST) {
    return cfg;
  }
  const plugins = cfg.plugins;
  const explicitConfig = hasExplicitPluginConfig(plugins);
  if (explicitConfig) {
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
      return cfg;
    }
    return {
      ...cfg,
      plugins: {
        ...plugins,
        slots: {
          ...plugins?.slots,
          memory: "none",
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...plugins,
      enabled: false,
      slots: {
        ...plugins?.slots,
        memory: "none",
      },
    },
  };
}

export function isTestDefaultMemorySlotDisabled(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.VITEST) {
    return false;
  }
  const plugins = cfg.plugins;
  if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
    return false;
  }
  return true;
}

export function resolvePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  autoEnabledReason?: string;
}): PluginActivationState {
  return toPluginActivationState(
    resolvePluginActivationDecisionShared({
      ...params,
      activationSource:
        params.activationSource ??
        createPluginActivationSource({
          config: params.rootConfig,
          plugins: params.config,
        }),
      allowBundledChannelExplicitBypassesAllowlist: true,
      isBundledChannelEnabledByChannelConfig,
    }),
  );
}

export const resolveEnableState = createPluginEnableStateResolver<
  NormalizedPluginsConfig,
  PluginOrigin
>(resolvePluginActivationState);

export const isBundledChannelEnabledByChannelConfig = isBundledChannelEnabledByChannelConfigShared;

type EffectiveActivationParams = {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
};

export const resolveEffectiveEnableState =
  createEffectiveEnableStateResolver<EffectiveActivationParams>(
    resolveEffectivePluginActivationState,
  );

export function resolveEffectivePluginActivationState(params: {
  id: EffectiveActivationParams["id"];
  origin: EffectiveActivationParams["origin"];
  config: EffectiveActivationParams["config"];
  rootConfig?: EffectiveActivationParams["rootConfig"];
  enabledByDefault?: EffectiveActivationParams["enabledByDefault"];
  activationSource?: EffectiveActivationParams["activationSource"];
  autoEnabledReason?: string;
}): PluginActivationState {
  return resolvePluginActivationState(params);
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string | string[];
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  return resolveMemorySlotDecisionShared(params);
}
