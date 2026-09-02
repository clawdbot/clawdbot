// Shares plugin activation state helpers across config and registry code.
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

type PluginKindLike = string | readonly string[] | undefined;

export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";

type PluginExplicitSelectionCause =
  | "enabled-in-config"
  | "bundled-channel-enabled-in-config"
  | "selected-memory-slot"
  | "selected-context-engine-slot"
  | "selected-in-allowlist";

type PluginActivationCause =
  | PluginExplicitSelectionCause
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "disabled-in-config"
  | "channel-disabled-in-config"
  | "workspace-disabled-by-default"
  | "not-in-allowlist"
  | "enabled-by-effective-config"
  | "bundled-channel-configured"
  | "bundled-default-enablement"
  | "bundled-disabled-by-default";

export type PluginActivationStateLike = {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  reason?: string;
};

type PluginActivationDecision = PluginActivationStateLike & {
  cause?: PluginActivationCause;
};

type PluginActivationConfigLike = {
  enabled: boolean;
  allow: readonly string[];
  deny: readonly string[];
  slots: {
    memory?: string | null;
    contextEngine?: string | null;
  };
  entries: Record<string, { enabled?: boolean } | undefined>;
};

export type PluginActivationConfigSourceLike<TRootConfig> = {
  plugins: PluginActivationConfigLike;
  rootConfig?: TRootConfig;
};

const PLUGIN_ACTIVATION_REASON_BY_CAUSE: Record<PluginActivationCause, string> = {
  "enabled-in-config": "enabled in config",
  "bundled-channel-enabled-in-config": "channel enabled in config",
  "selected-memory-slot": "selected memory slot",
  "selected-context-engine-slot": "selected context engine slot",
  "selected-in-allowlist": "selected in allowlist",
  "plugins-disabled": "plugins disabled",
  "blocked-by-denylist": "blocked by denylist",
  "disabled-in-config": "disabled in config",
  "channel-disabled-in-config": "channel disabled in config",
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

export function toPluginActivationState(
  decision: PluginActivationDecision,
): PluginActivationStateLike {
  return {
    enabled: decision.enabled,
    activated: decision.activated,
    explicitlyEnabled: decision.explicitlyEnabled,
    source: decision.source,
    reason: resolvePluginActivationReason(decision.cause, decision.reason),
  };
}

function resolveExplicitPluginSelectionShared<TRootConfig>(params: {
  id: string;
  origin: string;
  config: PluginActivationConfigLike;
  rootConfig?: TRootConfig;
  /** Manifest-owned channel ids; the plugin id alone cannot resolve `channels.<id>` for every owner. */
  channelIds?: readonly string[];
  resolveChannelConfigEnablement: (
    rootConfig: TRootConfig | undefined,
    pluginId: string,
    channelIds?: readonly string[],
  ) => boolean | undefined;
}): { explicitlyEnabled: boolean; cause?: PluginExplicitSelectionCause } {
  const policyId = normalizePluginPolicyId(params.id);
  if (params.config.entries[policyId]?.enabled === true) {
    return { explicitlyEnabled: true, cause: "enabled-in-config" };
  }
  if (
    params.origin === "bundled" &&
    params.resolveChannelConfigEnablement(params.rootConfig, params.id, params.channelIds) === true
  ) {
    return { explicitlyEnabled: true, cause: "bundled-channel-enabled-in-config" };
  }
  if (params.config.slots.memory === params.id) {
    return { explicitlyEnabled: true, cause: "selected-memory-slot" };
  }
  if (params.config.slots.contextEngine === params.id) {
    return { explicitlyEnabled: true, cause: "selected-context-engine-slot" };
  }
  if (params.origin !== "bundled" && params.config.allow.includes(policyId)) {
    return { explicitlyEnabled: true, cause: "selected-in-allowlist" };
  }
  return { explicitlyEnabled: false };
}

export function resolvePluginActivationDecisionShared<TRootConfig>(params: {
  id: string;
  origin: string;
  config: PluginActivationConfigLike;
  rootConfig?: TRootConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSourceLike<TRootConfig>;
  autoEnabledReason?: string;
  allowBundledChannelExplicitBypassesAllowlist?: boolean;
  /** Manifest-owned channel ids; the plugin id alone cannot resolve `channels.<id>` for every owner. */
  channelIds?: readonly string[];
  resolveChannelConfigEnablement: (
    rootConfig: TRootConfig | undefined,
    pluginId: string,
    channelIds?: readonly string[],
  ) => boolean | undefined;
}): PluginActivationDecision {
  const activationSource = params.activationSource ?? {
    plugins: params.config,
    rootConfig: params.rootConfig,
  };
  const explicitSelection = resolveExplicitPluginSelectionShared({
    id: params.id,
    origin: params.origin,
    config: activationSource.plugins,
    rootConfig: activationSource.rootConfig,
    channelIds: params.channelIds,
    resolveChannelConfigEnablement: params.resolveChannelConfigEnablement,
  });

  // Keep result construction shared; policy precedence stays in the ordered branches below.
  const decision = (
    source: PluginActivationSource,
    details: Partial<Pick<PluginActivationDecision, "explicitlyEnabled" | "cause" | "reason">> = {},
  ): PluginActivationDecision => ({
    enabled: source !== "disabled",
    activated: source !== "disabled",
    explicitlyEnabled: explicitSelection.explicitlyEnabled,
    source,
    ...details,
  });

  if (!params.config.enabled) {
    return decision("disabled", { cause: "plugins-disabled" });
  }
  const policyId = normalizePluginPolicyId(params.id);
  if (params.config.deny.includes(policyId)) {
    return decision("disabled", { cause: "blocked-by-denylist" });
  }
  const entry = params.config.entries[policyId];
  if (entry?.enabled === false) {
    return decision("disabled", { cause: "disabled-in-config" });
  }
  // `channels.<id>.enabled: false` is the operator's channel-level off switch. It must win over
  // `plugins.entries.<id>.enabled: true` left behind by install/enable flows, or the channel
  // plugin keeps importing (and can fail) for a channel the operator turned off.
  if (
    params.resolveChannelConfigEnablement(
      activationSource.rootConfig ?? params.rootConfig,
      params.id,
      params.channelIds,
    ) === false
  ) {
    return decision("disabled", { cause: "channel-disabled-in-config" });
  }
  const explicitlyAllowed = params.config.allow.includes(policyId);
  if (
    params.origin === "workspace" &&
    !explicitlyAllowed &&
    entry?.enabled !== true &&
    explicitSelection.cause !== "selected-context-engine-slot"
  ) {
    return decision("disabled", { cause: "workspace-disabled-by-default" });
  }
  if (params.config.slots.memory === params.id) {
    return decision("explicit", { explicitlyEnabled: true, cause: "selected-memory-slot" });
  }
  if (params.config.slots.contextEngine === params.id) {
    return decision("explicit", { explicitlyEnabled: true, cause: "selected-context-engine-slot" });
  }
  if (
    params.allowBundledChannelExplicitBypassesAllowlist === true &&
    explicitSelection.cause === "bundled-channel-enabled-in-config"
  ) {
    return decision("explicit", { explicitlyEnabled: true, cause: explicitSelection.cause });
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return decision("disabled", { cause: "not-in-allowlist" });
  }
  if (explicitSelection.explicitlyEnabled) {
    return decision("explicit", { explicitlyEnabled: true, cause: explicitSelection.cause });
  }
  if (params.autoEnabledReason) {
    return decision("auto", { explicitlyEnabled: false, reason: params.autoEnabledReason });
  }
  if (entry?.enabled === true) {
    return decision("auto", { explicitlyEnabled: false, cause: "enabled-by-effective-config" });
  }
  if (
    params.origin === "bundled" &&
    params.resolveChannelConfigEnablement(params.rootConfig, params.id, params.channelIds) === true
  ) {
    return decision("auto", { explicitlyEnabled: false, cause: "bundled-channel-configured" });
  }
  if (params.origin === "bundled" && params.enabledByDefault === true) {
    return decision("default", { explicitlyEnabled: false, cause: "bundled-default-enablement" });
  }
  if (params.origin === "bundled") {
    return decision("disabled", { explicitlyEnabled: false, cause: "bundled-disabled-by-default" });
  }
  return decision("default");
}

function hasKind(kind: PluginKindLike, target: string): boolean {
  if (!kind) {
    return false;
  }
  return Array.isArray(kind) ? kind.includes(target) : kind === target;
}

export function resolveMemorySlotDecisionShared(params: {
  id: string;
  kind?: PluginKindLike;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (!hasKind(params.kind, "memory")) {
    return { enabled: true };
  }
  // A dual-kind plugin (e.g. ["memory", "context-engine"]) that lost the
  // memory slot must stay enabled so its other slot role can still load.
  const isMultiKind = Array.isArray(params.kind) && params.kind.length > 1;
  if (params.slot === null) {
    return isMultiKind ? { enabled: true } : { enabled: false, reason: "memory slot disabled" };
  }
  if (typeof params.slot === "string") {
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot set to "${params.slot}"` };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot already filled by "${params.selectedId}"` };
  }
  return { enabled: true, selected: true };
}
