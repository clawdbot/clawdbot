import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemorySlotDecisionShared,
  resolveEnableStateShared,
  resolveEnableStateResult,
} from "./config-activation-shared.js";
import {
  hasExplicitPluginConfig as hasExplicitPluginConfigShared,
  identityNormalizePluginId,
  isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared,
  normalizePluginsConfigWithResolver as normalizePluginsConfigWithResolverShared,
  type NormalizePluginId,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import type { PluginKind, PluginOrigin } from "./types.js";

export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";

export type PluginActivationState = {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  reason?: string;
};

export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

export function normalizePluginsConfigWithResolver(
  config?: OpenClawConfig["plugins"],
  normalizePluginId: NormalizePluginId = identityNormalizePluginId,
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolverShared(config, normalizePluginId);
}

function resolveExplicitPluginSelection(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): { explicitlyEnabled: boolean; reason?: string } {
  if (params.config.entries[params.id]?.enabled === true) {
    return { explicitlyEnabled: true, reason: "enabled in config" };
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { explicitlyEnabled: true, reason: "channel enabled in config" };
  }
  if (params.config.slots.memory === params.id) {
    return { explicitlyEnabled: true, reason: "selected memory slot" };
  }
  if (params.config.slots.contextEngine === params.id) {
    return { explicitlyEnabled: true, reason: "selected context engine slot" };
  }
  if (params.origin !== "bundled" && params.config.allow.includes(params.id)) {
    return { explicitlyEnabled: true, reason: "selected in allowlist" };
  }
  return { explicitlyEnabled: false };
}

export function resolvePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: OpenClawConfig;
  autoEnabledReason?: string;
}): PluginActivationState {
  const explicitSelection = resolveExplicitPluginSelection({
    id: params.id,
    origin: params.origin,
    config: params.sourceConfig ?? params.config,
    rootConfig: params.sourceRootConfig ?? params.rootConfig,
  });

  if (!params.config.enabled) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      reason: "plugins disabled",
    };
  }
  if (params.config.deny.includes(params.id)) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      reason: "blocked by denylist",
    };
  }
  const entry = params.config.entries[params.id];
  if (entry?.enabled === false) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      reason: "disabled in config",
    };
  }
  const explicitlyAllowed = params.config.allow.includes(params.id);
  if (
    params.origin === "workspace" &&
    !explicitlyAllowed &&
    entry?.enabled !== true &&
    explicitSelection.reason !== "selected context engine slot"
  ) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      reason: "workspace plugin (disabled by default)",
    };
  }
  if (params.config.slots.memory === params.id) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      reason: "selected memory slot",
    };
  }
  if (params.config.slots.contextEngine === params.id) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      reason: "selected context engine slot",
    };
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      reason: "not in allowlist",
    };
  }
  if (explicitSelection.explicitlyEnabled) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      reason: explicitSelection.reason,
    };
  }
  if (params.autoEnabledReason) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      reason: params.autoEnabledReason,
    };
  }
  if (entry?.enabled === true) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      reason: "enabled by effective config",
    };
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      reason: "channel configured",
    };
  }
  if (params.origin === "bundled" && params.enabledByDefault === true) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "default",
      reason: "bundled default enablement",
    };
  }
  if (params.origin === "bundled") {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: false,
      source: "disabled",
      reason: "bundled (disabled by default)",
    };
  }
  return {
    enabled: true,
    activated: true,
    explicitlyEnabled: explicitSelection.explicitlyEnabled,
    source: "default",
  };
}
export function hasExplicitPluginConfig(plugins?: OpenClawConfig["plugins"]): boolean {
  return hasExplicitPluginConfigShared(plugins);
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
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: OpenClawConfig;
  autoEnabledReason?: string;
}): { enabled: boolean; reason?: string } {
  return resolveEnableStateResult(params, resolveEffectivePluginActivationState);
}

export function resolveEffectivePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: OpenClawConfig;
  autoEnabledReason?: string;
}): PluginActivationState {
  return resolvePluginActivationState(params);
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: PluginKind | PluginKind[];
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  return resolveMemorySlotDecisionShared(params);
}
