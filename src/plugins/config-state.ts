import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  resolveMemorySlotDecisionShared,
  resolveEnableStateShared,
  resolveEnableStateResult,
} from "./config-activation-shared.js";
import {
  hasExplicitPluginConfig as hasExplicitPluginConfigShared,
  isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared,
  normalizePluginsConfigWithResolver,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";

export type PluginExplicitSelectionCause =
  | "enabled-in-config"
  | "bundled-channel-enabled-in-config"
  | "selected-memory-slot"
  | "selected-context-engine-slot"
  | "selected-in-allowlist";

export type PluginActivationCause =
  | PluginExplicitSelectionCause
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "disabled-in-config"
  | "workspace-disabled-by-default"
  | "not-in-allowlist"
  | "enabled-by-effective-config"
  | "bundled-channel-configured"
  | "bundled-default-enablement"
  | "bundled-disabled-by-default";

export type PluginActivationState = {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  reason?: string;
};

type PluginActivationDecision = {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  cause?: PluginActivationCause;
  reason?: string;
};

export type PluginActivationConfigSource = {
  plugins: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
};

export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

let bundledPluginAliasLookupCache: ReadonlyMap<string, string> | undefined;

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
  bundledPluginAliasLookupCache = lookup;
  return lookup;
}

export function normalizePluginId(id: string): string {
  const trimmed = normalizeOptionalString(id) ?? "";
  const normalized = normalizeOptionalLowercaseString(trimmed) ?? "";
  return getBundledPluginAliasLookup().get(normalized) ?? trimmed;
}

const PLUGIN_ACTIVATION_REASON_BY_CAUSE: Record<PluginActivationCause, string> = {
  "enabled-in-config": "enabled in config",
  "bundled-channel-enabled-in-config": "channel enabled in config",
  "selected-memory-slot": "selected memory slot",
  "selected-context-engine-slot": "selected context engine slot",
  "selected-in-allowlist": "selected in allowlist",
  "plugins-disabled": "plugins disabled",
  "blocked-by-denylist": "blocked by denylist",
  "disabled-in-config": "disabled in config",
  "workspace-disabled-by-default": "workspace plugin (disabled by default)",
  "not-in-allowlist": "not in allowlist",
  "enabled-by-effective-config": "enabled by effective config",
  "bundled-channel-configured": "channel configured",
  "bundled-default-enablement": "bundled default enablement",
  "bundled-disabled-by-default": "bundled (disabled by default)",
};

function resolvePluginActivationReason(
  cause?: PluginActivationCause,
  reason?: string,
): string | undefined {
  if (reason) {
    return reason;
  }
  return cause ? PLUGIN_ACTIVATION_REASON_BY_CAUSE[cause] : undefined;
}

function toPluginActivationState(decision: PluginActivationDecision): PluginActivationState {
  return {
    enabled: decision.enabled,
    activated: decision.activated,
    explicitlyEnabled: decision.explicitlyEnabled,
    source: decision.source,
    reason: resolvePluginActivationReason(decision.cause, decision.reason),
  };
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
  Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "memory-core"));

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

function resolveExplicitPluginSelection(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): { explicitlyEnabled: boolean; cause?: PluginExplicitSelectionCause } {
  if (params.config.entries[params.id]?.enabled === true) {
    return { explicitlyEnabled: true, cause: "enabled-in-config" };
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { explicitlyEnabled: true, cause: "bundled-channel-enabled-in-config" };
  }
  if (params.config.slots.memory === params.id) {
    return { explicitlyEnabled: true, cause: "selected-memory-slot" };
  }
  if (params.config.slots.contextEngine === params.id) {
    return { explicitlyEnabled: true, cause: "selected-context-engine-slot" };
  }
  if (params.origin !== "bundled" && params.config.allow.includes(params.id)) {
    return { explicitlyEnabled: true, cause: "selected-in-allowlist" };
  }
  return { explicitlyEnabled: false };
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
  const activationSource =
    params.activationSource ??
    createPluginActivationSource({
      config: params.rootConfig,
      plugins: params.config,
    });
  const explicitSelection = resolveExplicitPluginSelection({
    id: params.id,
    origin: params.origin,
    config: activationSource.plugins,
    rootConfig: activationSource.rootConfig,
  });

  if (!params.config.enabled) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "plugins-disabled",
    });
  }
  if (params.config.deny.includes(params.id)) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "blocked-by-denylist",
    });
  }
  const entry = params.config.entries[params.id];
  if (entry?.enabled === false) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "disabled-in-config",
    });
  }
  const explicitlyAllowed = params.config.allow.includes(params.id);
  if (
    params.origin === "workspace" &&
    !explicitlyAllowed &&
    entry?.enabled !== true &&
    explicitSelection.cause !== "selected-context-engine-slot"
  ) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "workspace-disabled-by-default",
    });
  }
  if (params.config.slots.memory === params.id) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: "selected-memory-slot",
    });
  }
  if (params.config.slots.contextEngine === params.id) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: "selected-context-engine-slot",
    });
  }
  if (explicitSelection.cause === "bundled-channel-enabled-in-config") {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: explicitSelection.cause,
    });
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "not-in-allowlist",
    });
  }
  if (explicitSelection.explicitlyEnabled) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: explicitSelection.cause,
    });
  }
  if (params.autoEnabledReason) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      reason: params.autoEnabledReason,
    });
  }
  if (entry?.enabled === true) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      cause: "enabled-by-effective-config",
    });
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      cause: "bundled-channel-configured",
    });
  }
  if (params.origin === "bundled" && params.enabledByDefault === true) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "default",
      cause: "bundled-default-enablement",
    });
  }
  if (params.origin === "bundled") {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: false,
      source: "disabled",
      cause: "bundled-disabled-by-default",
    });
  }
  return toPluginActivationState({
    enabled: true,
    activated: true,
    explicitlyEnabled: explicitSelection.explicitlyEnabled,
    source: "default",
  });
}

export function resolveEnableState(
  id: string,
  origin: PluginOrigin,
  config: NormalizedPluginsConfig,
  enabledByDefault?: boolean,
): { enabled: boolean; reason?: string } {
  return resolveEnableStateShared(
    { id, origin, config, enabledByDefault },
    resolvePluginActivationState,
  );
}

export function isBundledChannelEnabledByChannelConfig(
  cfg: OpenClawConfig | undefined,
  pluginId: string,
): boolean {
  return isBundledChannelEnabledByChannelConfigShared(cfg, pluginId);
}

export function resolveEffectiveEnableState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
}): { enabled: boolean; reason?: string } {
  return resolveEnableStateResult(params, resolveEffectivePluginActivationState);
}

export function resolveEffectivePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
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
