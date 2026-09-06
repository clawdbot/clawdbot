import { isRecord } from "@openclaw/normalization-core/record-coerce";
/** Normalizes plugin config and resolves effective enablement, slots, and activation sources. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { mergeDeep } from "../infra/deep-merge.js";
import {
  resolveMemorySlotDecisionShared,
  resolvePluginActivationDecisionShared,
  toPluginActivationState,
  type PluginActivationConfigSourceLike,
  type PluginActivationSource,
  type PluginActivationStateLike,
} from "./config-activation-shared.js";
import {
  normalizePluginsConfigWithResolverCore,
  resolveChannelConfigEnablement,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { defaultSlotIdForKey } from "./slots.js";

export type { PluginActivationSource };
export type PluginActivationState = PluginActivationStateLike;

export type PluginActivationConfigSource = {
  plugins: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
} & PluginActivationConfigSourceLike<OpenClawConfig>;

export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

const BUILT_IN_PLUGIN_ALIAS_FALLBACKS: ReadonlyArray<readonly [alias: string, pluginId: string]> = [
  ["google-gemini-cli", "google"],
  ["minimax-portal", "minimax"],
  ["minimax-portal-auth", "minimax"],
] as const;
const BUILT_IN_PLUGIN_ALIAS_LOOKUP = new Map<string, string>([
  ...BUILT_IN_PLUGIN_ALIAS_FALLBACKS,
  ...BUILT_IN_PLUGIN_ALIAS_FALLBACKS.map(([, pluginId]) => [pluginId, pluginId] as const),
]);
const RETIRED_PLUGIN_IDS = new Set([
  "google-antigravity-auth",
  "google-gemini-cli-auth",
  "skill-workshop",
]);

/** Normalizes user/config plugin ids into the canonical lowercase key form. */
export function normalizePluginId(id: string): string {
  const normalized = normalizeOptionalLowercaseString(id) ?? "";
  return BUILT_IN_PLUGIN_ALIAS_LOOKUP.get(normalized) ?? normalized;
}

export function isRetiredPluginId(id: string): boolean {
  return RETIRED_PLUGIN_IDS.has(normalizePluginId(id));
}

/** Identifies the credential-free marker that records an explicit plugin disable decision. */
export function isExplicitPluginDisableMarker(value: unknown): boolean {
  return isRecord(value) && value.enabled === false && Object.keys(value).length === 1;
}

export const normalizePluginsConfig = (
  config?: OpenClawConfig["plugins"],
): NormalizedPluginsConfig => {
  return normalizePluginsConfigWithResolverCore(config, normalizePluginId);
};

/** Resolves the enabled plugin selected to own the context-engine slot. */
export function resolveSelectedContextEnginePluginId(config?: OpenClawConfig): string | undefined {
  const plugins = normalizePluginsConfig(config?.plugins);
  return resolveSelectedContextEnginePluginIdFromConfig(plugins, plugins.slots.contextEngine);
}

export function resolveSelectedContextEnginePluginIdFromConfig(
  plugins: NormalizedPluginsConfig,
  pluginId: string | null | undefined,
): string | undefined {
  if (
    !plugins.enabled ||
    !pluginId ||
    pluginId === defaultSlotIdForKey("contextEngine") ||
    plugins.deny.includes(pluginId) ||
    plugins.entries[pluginId]?.enabled === false
  ) {
    return undefined;
  }
  return pluginId;
}

/**
 * Merges every raw entry resolving to one plugin id into a single persisted entry.
 *
 * Two precedences, because two different things are being merged.
 *
 * Policy (`enabled`, `hooks`, `subagent`, `llm`) folds in **file order**, which is how runtime
 * normalization resolves it: the last raw entry wins. Any other order rewrites live policy.
 * A later legacy alias denying `allowConversationAccess` or an LLM override is the effective
 * setting, so folding canonical-last would write the grant back and hand the plugin a
 * permission it is currently being refused.
 *
 * The config payload folds with the canonical entry **last**, so canonical values win a key
 * clash whichever order the two sit in the file, and nothing is dropped from either side.
 *
 * Raw entries are the base throughout. The normalized entry is runtime policy rather than
 * persisted config: it carries derived keys such as `hasAllowedModelsConfig` that the strict
 * schema forbids, and it replaces the `allowedModels` list they were derived from.
 */
export function mergePluginEntryAliases(
  config: OpenClawConfig,
  pluginId: string,
): PluginEntryConfig {
  const resolvedId = normalizePluginId(pluginId);
  const inFileOrder = Object.entries(config.plugins?.entries ?? {}).filter(
    ([entryId]) => normalizePluginId(entryId) === resolvedId,
  );
  const canonicalLast = inFileOrder.toSorted(([leftId], [rightId]) => {
    if (leftId === resolvedId) {
      return rightId === resolvedId ? 0 : 1;
    }
    if (rightId === resolvedId) {
      return -1;
    }
    return leftId.localeCompare(rightId, "en");
  });

  let policy: PluginEntryConfig = {};
  for (const [, entry] of inFileOrder) {
    const { config: _payload, ...rest } = entry;
    policy = mergeDeep(policy, rest) as PluginEntryConfig;
  }

  let payload: Record<string, unknown> = {};
  for (const [, entry] of canonicalLast) {
    if (isRecord(entry.config)) {
      payload = mergeDeep(payload, entry.config) as Record<string, unknown>;
    }
  }

  return {
    ...policy,
    ...(Object.keys(payload).length > 0 ? { config: payload } : {}),
  };
}

/** Canonicalizes one plugin entry and its policy-list ids before a targeted mutation. */
export function normalizePluginTargetConfig(
  config: OpenClawConfig,
  pluginId: string,
): OpenClawConfig {
  const normalizedId = normalizePluginId(pluginId);
  const normalized = normalizePluginsConfig(config.plugins);
  const rawEntries = config.plugins?.entries ?? {};
  const hasTargetEntry = Object.keys(rawEntries).some(
    (entryId) => normalizePluginId(entryId) === normalizedId,
  );
  const entries = Object.fromEntries(
    Object.entries(rawEntries).filter(([entryId]) => normalizePluginId(entryId) !== normalizedId),
  );
  if (hasTargetEntry) {
    const { config: pluginConfig, ...entry } = normalized.entries[normalizedId] ?? {};
    entries[normalizedId] = {
      ...entry,
      ...(isRecord(pluginConfig) ? { config: pluginConfig } : {}),
    };
  }
  return {
    ...config,
    plugins: {
      ...config.plugins,
      ...(Array.isArray(config.plugins?.allow) ? { allow: normalized.allow } : {}),
      ...(Array.isArray(config.plugins?.deny) ? { deny: normalized.deny } : {}),
      entries,
    },
  };
}

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
  Boolean(plugins?.slots && Object.hasOwn(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.entries && Object.hasOwn(plugins.entries, defaultSlotIdForKey("memory")));

export function hasExplicitPluginConfig(plugins?: OpenClawConfig["plugins"]): boolean {
  if (!plugins) {
    return false;
  }
  if (typeof plugins.enabled === "boolean") {
    return true;
  }
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
    return true;
  }
  if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.slots && Object.keys(plugins.slots).length > 0) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).length > 0) {
    return true;
  }
  return false;
}

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

function resolvePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  autoEnabledReason?: string;
  channelIds?: readonly string[];
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
      resolveChannelConfigEnablement,
    }),
  );
}

function toEnableStateResult(state: PluginActivationState): { enabled: boolean; reason?: string } {
  return state.enabled ? { enabled: true } : { enabled: false, reason: state.reason };
}

export const resolveEnableState = (
  id: string,
  origin: PluginOrigin,
  config: NormalizedPluginsConfig,
  enabledByDefault?: boolean,
): { enabled: boolean; reason?: string } =>
  toEnableStateResult(resolvePluginActivationState({ id, origin, config, enabledByDefault }));

type EffectiveActivationParams = {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  channelIds?: readonly string[];
};

export const resolveEffectiveEnableState = (
  params: EffectiveActivationParams,
): { enabled: boolean; reason?: string } =>
  toEnableStateResult(resolveEffectivePluginActivationState(params));

export function resolveEffectivePluginActivationState(params: {
  id: EffectiveActivationParams["id"];
  origin: EffectiveActivationParams["origin"];
  config: EffectiveActivationParams["config"];
  rootConfig?: EffectiveActivationParams["rootConfig"];
  enabledByDefault?: EffectiveActivationParams["enabledByDefault"];
  activationSource?: EffectiveActivationParams["activationSource"];
  autoEnabledReason?: string;
  channelIds?: EffectiveActivationParams["channelIds"];
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
