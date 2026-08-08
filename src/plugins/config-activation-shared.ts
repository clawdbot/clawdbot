// Shares plugin activation state helpers across config and registry code.
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import { MEMORY_PLUGIN_SLOT_KEYS, defaultSlotIdForKey } from "./slots.js";

type EnableStateLike = {
  enabled: boolean;
  reason?: string;
};

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
    "memory.recall"?: string | null;
    "memory.compaction"?: string | null;
    "memory.capture"?: string | null;
    "memory.dreaming"?: string | null;
    "memory.userModel"?: string | null;
    contextEngine?: string | null;
  };
  entries: Record<string, { enabled?: boolean } | undefined>;
};

type PluginHardBlockConfigLike = Pick<PluginActivationConfigLike, "deny" | "entries">;
type MemoryRoleSelectionConfigLike = Pick<PluginActivationConfigLike, "enabled"> &
  PluginHardBlockConfigLike;

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

export function isPluginPolicyHardBlocked(
  pluginId: string,
  ...configs: readonly (PluginHardBlockConfigLike | undefined)[]
): boolean {
  const policyId = normalizePluginPolicyId(pluginId);
  if (!policyId || policyId === "none") {
    return true;
  }
  return configs.some(
    (config) =>
      Boolean(config?.deny.includes(policyId)) || config?.entries[policyId]?.enabled === false,
  );
}

export function isMemoryRoleSelectedSlotActivationAllowed(params: {
  pluginId: string;
  config: MemoryRoleSelectionConfigLike;
}): boolean {
  return params.config.enabled && !isPluginPolicyHardBlocked(params.pluginId, params.config);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSelectedMemorySlot(
  config: PluginActivationConfigLike,
  id: string,
  rootConfig?: unknown,
): boolean {
  if (rootConfig !== undefined) {
    const rootPlugins = (rootConfig as { plugins?: { slots?: unknown } }).plugins;
    const rootSlots = rootPlugins?.slots;
    if (!isRecordLike(rootSlots)) {
      return false;
    }
    return MEMORY_PLUGIN_SLOT_KEYS.some(
      (slotKey) => Object.hasOwn(rootSlots, slotKey) && config.slots[slotKey] === id,
    );
  }
  return MEMORY_PLUGIN_SLOT_KEYS.some((slotKey) => config.slots[slotKey] === id);
}

function resolveExplicitPluginSelectionShared<TRootConfig>(params: {
  id: string;
  origin: string;
  config: PluginActivationConfigLike;
  rootConfig?: TRootConfig;
  isBundledChannelEnabledByChannelConfig: (
    rootConfig: TRootConfig | undefined,
    pluginId: string,
  ) => boolean;
}): { explicitlyEnabled: boolean; cause?: PluginExplicitSelectionCause } {
  const policyId = normalizePluginPolicyId(params.id);
  if (params.config.entries[policyId]?.enabled === true) {
    return { explicitlyEnabled: true, cause: "enabled-in-config" };
  }
  if (
    params.origin === "bundled" &&
    params.isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { explicitlyEnabled: true, cause: "bundled-channel-enabled-in-config" };
  }
  if (isSelectedMemorySlot(params.config, params.id, params.rootConfig)) {
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
  isBundledChannelEnabledByChannelConfig: (
    rootConfig: TRootConfig | undefined,
    pluginId: string,
  ) => boolean;
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
    isBundledChannelEnabledByChannelConfig: params.isBundledChannelEnabledByChannelConfig,
  });

  if (!params.config.enabled) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "plugins-disabled",
    };
  }
  const policyId = normalizePluginPolicyId(params.id);
  if (params.config.deny.includes(policyId)) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "blocked-by-denylist",
    };
  }
  const entry = params.config.entries[policyId];
  if (entry?.enabled === false) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "disabled-in-config",
    };
  }
  const explicitlyAllowed = params.config.allow.includes(policyId);
  const explicitNonDefaultMemorySlot =
    explicitSelection.cause === "selected-memory-slot" &&
    params.id !== defaultSlotIdForKey("memory.recall");
  if (
    params.origin === "workspace" &&
    !explicitlyAllowed &&
    entry?.enabled !== true &&
    !explicitNonDefaultMemorySlot &&
    explicitSelection.cause !== "selected-context-engine-slot"
  ) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "workspace-disabled-by-default",
    };
  }
  if (explicitSelection.cause === "selected-memory-slot") {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: "selected-memory-slot",
    };
  }
  if (params.config.slots.contextEngine === params.id) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: "selected-context-engine-slot",
    };
  }
  if (
    params.allowBundledChannelExplicitBypassesAllowlist === true &&
    explicitSelection.cause === "bundled-channel-enabled-in-config"
  ) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: explicitSelection.cause,
    };
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "not-in-allowlist",
    };
  }
  if (explicitSelection.explicitlyEnabled) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: explicitSelection.cause,
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
      cause: "enabled-by-effective-config",
    };
  }
  if (
    params.origin === "bundled" &&
    params.isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      cause: "bundled-channel-configured",
    };
  }
  if (params.origin === "bundled" && params.enabledByDefault === true) {
    return {
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "default",
      cause: "bundled-default-enablement",
    };
  }
  if (params.origin === "bundled") {
    return {
      enabled: false,
      activated: false,
      explicitlyEnabled: false,
      source: "disabled",
      cause: "bundled-disabled-by-default",
    };
  }
  return {
    enabled: true,
    activated: true,
    explicitlyEnabled: explicitSelection.explicitlyEnabled,
    source: "default",
  };
}

function toEnableStateResult(state: EnableStateLike): { enabled: boolean; reason?: string } {
  return state.enabled ? { enabled: true } : { enabled: false, reason: state.reason };
}

function resolveEnableStateResult<TParams>(
  params: TParams,
  resolveState: (params: TParams) => EnableStateLike,
): { enabled: boolean; reason?: string } {
  return toEnableStateResult(resolveState(params));
}

export function createPluginEnableStateResolver<TConfig, TOrigin extends string>(
  resolveState: (params: {
    id: string;
    origin: TOrigin;
    config: TConfig;
    enabledByDefault?: boolean;
  }) => EnableStateLike,
): (
  id: string,
  origin: TOrigin,
  config: TConfig,
  enabledByDefault?: boolean,
) => { enabled: boolean; reason?: string } {
  return (id, origin, config, enabledByDefault) =>
    resolveEnableStateResult({ id, origin, config, enabledByDefault }, resolveState);
}

export function createEffectiveEnableStateResolver<TParams>(
  resolveState: (params: TParams) => EnableStateLike,
): (params: TParams) => { enabled: boolean; reason?: string } {
  return (params) => resolveEnableStateResult(params, resolveState);
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
  slot: string | null | undefined | readonly (string | null | undefined)[];
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (!hasKind(params.kind, "memory")) {
    return { enabled: true };
  }
  // A dual-kind plugin (e.g. ["memory", "context-engine"]) that lost the
  // memory slot must stay enabled so its other slot role can still load.
  const isMultiKind = Array.isArray(params.kind) && params.kind.length > 1;
  const slots = Array.isArray(params.slot) ? params.slot : [params.slot];
  if (slots.some((slot) => slot === params.id)) {
    return { enabled: true, selected: true };
  }
  const configuredSlots = slots.filter(
    (slot): slot is string | null => slot === null || typeof slot === "string",
  );
  if (configuredSlots.length > 0 && configuredSlots.every((slot) => slot === null)) {
    return isMultiKind ? { enabled: true } : { enabled: false, reason: "memory slot disabled" };
  }
  const selectedSlots = configuredSlots.filter((slot): slot is string => typeof slot === "string");
  if (selectedSlots.length > 0) {
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot set to "${selectedSlots.join(", ")}"` };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot already filled by "${params.selectedId}"` };
  }
  return { enabled: true, selected: true };
}
