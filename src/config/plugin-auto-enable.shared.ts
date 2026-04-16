import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import {
  hasPotentialConfiguredChannels,
  listPotentialConfiguredChannelIds,
} from "../channels/config-presence.js";
import { getChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import {
  loadPluginManifestRegistry,
  resolveManifestContractOwnerPluginId,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { resolveOwningPluginIdsForModelRef } from "../plugins/providers.js";
import { resolvePluginSetupAutoEnableReasons } from "../plugins/setup-registry.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { isChannelConfigured } from "./channel-configured.js";
import { shouldSkipPreferredPluginAutoEnable } from "./plugin-auto-enable.prefer-over.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
import type { OpenClawConfig } from "./types.openclaw.js";
export type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";

const EMPTY_PLUGIN_MANIFEST_REGISTRY: PluginManifestRegistry = {
  plugins: [],
  diagnostics: [],
};

function resolveAutoEnableProviderPluginIds(
  registry: PluginManifestRegistry,
): Readonly<Record<string, string>> {
  const entries = new Map<string, string>();
  for (const plugin of registry.plugins) {
    for (const providerId of plugin.autoEnableWhenConfiguredProviders ?? []) {
      if (!entries.has(providerId)) {
        entries.set(providerId, plugin.id);
      }
    }
  }
  return Object.fromEntries(entries);
}

function collectModelRefs(cfg: OpenClawConfig): string[] {
  const refs: string[] = [];
  const pushModelRef = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      refs.push(value.trim());
    }
  };
  const collectFromAgent = (agent: Record<string, unknown> | null | undefined) => {
    if (!agent) {
      return;
    }
    const model = agent.model;
    if (typeof model === "string") {
      pushModelRef(model);
    } else if (isRecord(model)) {
      pushModelRef(model.primary);
      const fallbacks = model.fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const entry of fallbacks) {
          pushModelRef(entry);
        }
      }
    }
    const models = agent.models;
    if (isRecord(models)) {
      for (const key of Object.keys(models)) {
        pushModelRef(key);
      }
    }
  };

  collectFromAgent(cfg.agents?.defaults as Record<string, unknown> | undefined);
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isRecord(entry)) {
        collectFromAgent(entry);
      }
    }
  }
  return refs;
}

function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}

function hasConfiguredEmbeddedHarnessRuntime(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  return collectConfiguredAgentHarnessRuntimes(cfg, env).length > 0;
}

function resolveAgentHarnessOwnerPluginIds(
  registry: PluginManifestRegistry,
  runtime: string,
): string[] {
  const normalizedRuntime = normalizeOptionalLowercaseString(runtime);
  if (!normalizedRuntime) {
    return [];
  }
  return registry.plugins
    .filter((plugin) =>
      (plugin.activation?.onAgentHarnesses ?? []).some(
        (entry) => normalizeOptionalLowercaseString(entry) === normalizedRuntime,
      ),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function isProviderConfigured(cfg: OpenClawConfig, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  const profiles = cfg.auth?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (!isRecord(profile)) {
        continue;
      }
      const provider = normalizeProviderId(profile.provider ?? "");
      if (provider === normalized) {
        return true;
      }
    }
  }

  const providerConfig = cfg.models?.providers;
  if (providerConfig && typeof providerConfig === "object") {
    for (const key of Object.keys(providerConfig)) {
      if (normalizeProviderId(key) === normalized) {
        return true;
      }
    }
  }

  for (const ref of collectModelRefs(cfg)) {
    const provider = extractProviderFromModelRef(ref);
    if (provider && provider === normalized) {
      return true;
    }
  }

  return false;
}

function hasPluginOwnedWebSearchConfig(cfg: OpenClawConfig, pluginId: string): boolean {
  const pluginConfig = cfg.plugins?.entries?.[pluginId]?.config;
  return isRecord(pluginConfig) && isRecord(pluginConfig.webSearch);
}

function hasPluginOwnedWebFetchConfig(cfg: OpenClawConfig, pluginId: string): boolean {
  const pluginConfig = cfg.plugins?.entries?.[pluginId]?.config;
  return isRecord(pluginConfig) && isRecord(pluginConfig.webFetch);
}

function resolvePluginOwnedToolConfigKeys(plugin: PluginManifestRecord): string[] {
  if ((plugin.contracts?.tools?.length ?? 0) === 0) {
    return [];
  }
  const properties = isRecord(plugin.configSchema) ? plugin.configSchema.properties : undefined;
  if (!isRecord(properties)) {
    return [];
  }
  return Object.keys(properties).filter((key) => key !== "webSearch" && key !== "webFetch");
}

function hasPluginOwnedToolConfig(cfg: OpenClawConfig, plugin: PluginManifestRecord): boolean {
  const pluginConfig = cfg.plugins?.entries?.[plugin.id]?.config;
  if (!isRecord(pluginConfig)) {
    return false;
  }
  return resolvePluginOwnedToolConfigKeys(plugin).some((key) => pluginConfig[key] !== undefined);
}

function resolveProviderPluginsWithOwnedWebSearch(
  registry: PluginManifestRegistry,
): PluginManifestRecord[] {
  return registry.plugins
    .filter((plugin) => (plugin.providers?.length ?? 0) > 0)
    .filter((plugin) => (plugin.contracts?.webSearchProviders?.length ?? 0) > 0);
}

function resolveProviderPluginsWithOwnedWebFetch(
  registry: PluginManifestRegistry,
): PluginManifestRecord[] {
  return registry.plugins.filter(
    (plugin) => (plugin.contracts?.webFetchProviders?.length ?? 0) > 0,
  );
}

function resolvePluginsWithOwnedToolConfig(
  registry: PluginManifestRegistry,
): PluginManifestRecord[] {
  return registry.plugins.filter((plugin) => (plugin.contracts?.tools?.length ?? 0) > 0);
}

function resolvePluginIdForConfiguredWebFetchProvider(
  providerId: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return resolveManifestContractOwnerPluginId({
    contract: "webFetchProviders",
    value: normalizeOptionalLowercaseString(providerId) ?? "",
    origin: "bundled",
    env,
  });
}

function buildChannelToPluginIdMap(registry: PluginManifestRegistry): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of registry.plugins) {
    for (const channelId of record.channels ?? []) {
      if (channelId && !map.has(channelId)) {
        map.set(channelId, record.id);
      }
    }
  }
  return map;
}

function resolvePluginIdForChannel(
  channelId: string,
  channelToPluginId: ReadonlyMap<string, string>,
): string {
  const builtInId = normalizeChatChannelId(channelId);
  if (builtInId) {
    return builtInId;
  }
  return channelToPluginId.get(channelId) ?? channelId;
}

function collectCandidateChannelIds(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  return listPotentialConfiguredChannelIds(cfg, env).map(
    (channelId) => normalizeChatChannelId(channelId) ?? channelId,
  );
}

function hasConfiguredWebSearchPluginEntry(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  return (
    !!entries &&
    typeof entries === "object" &&
    Object.values(entries).some(
      (entry) => isRecord(entry) && isRecord(entry.config) && isRecord(entry.config.webSearch),
    )
  );
}

function hasConfiguredWebFetchPluginEntry(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  return (
    !!entries &&
    typeof entries === "object" &&
    Object.values(entries).some(
      (entry) => isRecord(entry) && isRecord(entry.config) && isRecord(entry.config.webFetch),
    )
  );
}

function hasConfiguredPluginConfigEntry(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  return (
    !!entries &&
    typeof entries === "object" &&
    Object.values(entries).some((entry) => isRecord(entry) && isRecord(entry.config))
  );
}

function listContainsNormalized(value: unknown, expected: string): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => normalizeOptionalLowercaseString(entry) === expected)
  );
}

function toolPolicyReferencesBrowser(value: unknown): boolean {
  return (
    isRecord(value) &&
    (listContainsNormalized(value.allow, "browser") ||
      listContainsNormalized(value.alsoAllow, "browser"))
  );
}

function hasBrowserToolReference(cfg: OpenClawConfig): boolean {
  if (toolPolicyReferencesBrowser(cfg.tools)) {
    return true;
  }
  const agentList = cfg.agents?.list;
  return Array.isArray(agentList)
    ? agentList.some((entry) => isRecord(entry) && toolPolicyReferencesBrowser(entry.tools))
    : false;
}

function hasSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  if (isRecord(cfg.browser) || isRecord(cfg.acp) || hasBrowserToolReference(cfg)) {
    return true;
  }
  if (isRecord(entries?.browser) || isRecord(entries?.acpx) || isRecord(entries?.xai)) {
    return true;
  }
  if (isRecord(cfg.tools?.web) && isRecord((cfg.tools.web as Record<string, unknown>).x_search)) {
    return true;
  }
  return hasConfiguredPluginConfigEntry(cfg);
}

function hasPluginEntries(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  return !!entries && typeof entries === "object" && Object.keys(entries).length > 0;
}

function configMayNeedPluginManifestRegistry(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  const pluginEntries = cfg.plugins?.entries;
  if (Array.isArray(cfg.plugins?.allow) && cfg.plugins.allow.length > 0 && hasPluginEntries(cfg)) {
    return true;
  }
  if (
    pluginEntries &&
    Object.values(pluginEntries).some((entry) => isRecord(entry) && isRecord(entry.config))
  ) {
    return true;
  }
  if (cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) {
    return true;
  }
  if (cfg.models?.providers && Object.keys(cfg.models.providers).length > 0) {
    return true;
  }
  if (collectModelRefs(cfg).length > 0) {
    return true;
  }
  if (hasConfiguredEmbeddedHarnessRuntime(cfg, env)) {
    return true;
  }
  const configuredChannels = cfg.channels as Record<string, unknown> | undefined;
  if (!configuredChannels || typeof configuredChannels !== "object") {
    return false;
  }
  for (const key of Object.keys(configuredChannels)) {
    if (key === "defaults" || key === "modelByChannel") {
      continue;
    }
    if (!normalizeChatChannelId(key)) {
      return true;
    }
  }
  return false;
}

export function configMayNeedPluginAutoEnable(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  if (Array.isArray(cfg.plugins?.allow) && cfg.plugins.allow.length > 0 && hasPluginEntries(cfg)) {
    return true;
  }
  if (hasConfiguredPluginConfigEntry(cfg)) {
    return true;
  }
  if (hasPotentialConfiguredChannels(cfg, env)) {
    return true;
  }
  if (cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) {
    return true;
  }
  if (cfg.models?.providers && Object.keys(cfg.models.providers).length > 0) {
    return true;
  }
  if (collectModelRefs(cfg).length > 0) {
    return true;
  }
  if (hasConfiguredEmbeddedHarnessRuntime(cfg, env)) {
    return true;
  }
  if (hasConfiguredWebSearchPluginEntry(cfg) || hasConfiguredWebFetchPluginEntry(cfg)) {
    return true;
  }
  if (!hasSetupAutoEnableRelevantConfig(cfg)) {
    return false;
  }
  return (
    resolvePluginSetupAutoEnableReasons({
      config: cfg,
      env,
    }).length > 0
  );
}

export function resolvePluginAutoEnableCandidateReason(
  candidate: PluginAutoEnableCandidate,
): string {
  switch (candidate.kind) {
    case "channel-configured":
      return `${candidate.channelId} configured`;
    case "provider-auth-configured":
      return `${candidate.providerId} auth configured`;
    case "provider-model-configured":
      return `${candidate.modelRef} model configured`;
    case "agent-harness-runtime-configured":
      return `${candidate.runtime} agent harness runtime configured`;
    case "web-fetch-provider-selected":
      return `${candidate.providerId} web fetch provider selected`;
    case "plugin-web-search-configured":
      return `${candidate.pluginId} web search configured`;
    case "plugin-web-fetch-configured":
      return `${candidate.pluginId} web fetch configured`;
    case "plugin-tool-configured":
      return `${candidate.pluginId} tool configured`;
    case "setup-auto-enable":
      return candidate.reason;
  }
  throw new Error("Unsupported plugin auto-enable candidate");
}

export function resolveConfiguredPluginAutoEnableCandidates(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  registry: PluginManifestRegistry;
}): PluginAutoEnableCandidate[] {
  const changes: PluginAutoEnableCandidate[] = [];
  const channelToPluginId = buildChannelToPluginIdMap(params.registry);
  for (const channelId of collectCandidateChannelIds(params.config, params.env)) {
    const pluginId = resolvePluginIdForChannel(channelId, channelToPluginId);
    if (isChannelConfigured(params.config, channelId, params.env)) {
      changes.push({ pluginId, kind: "channel-configured", channelId });
    }
  }

  for (const [providerId, pluginId] of Object.entries(
    resolveAutoEnableProviderPluginIds(params.registry),
  )) {
    if (isProviderConfigured(params.config, providerId)) {
      changes.push({ pluginId, kind: "provider-auth-configured", providerId });
    }
  }

  for (const modelRef of collectModelRefs(params.config)) {
    const owningPluginIds = resolveOwningPluginIdsForModelRef({
      model: modelRef,
      config: params.config,
      env: params.env,
      manifestRegistry: params.registry,
    });
    if (owningPluginIds?.length === 1) {
      changes.push({
        pluginId: owningPluginIds[0],
        kind: "provider-model-configured",
        modelRef,
      });
    }
  }

  for (const runtime of collectConfiguredAgentHarnessRuntimes(params.config, params.env)) {
    const pluginIds = resolveAgentHarnessOwnerPluginIds(params.registry, runtime);
    for (const pluginId of pluginIds) {
      changes.push({
        pluginId,
        kind: "agent-harness-runtime-configured",
        runtime,
      });
    }
  }

  const webFetchProvider =
    typeof params.config.tools?.web?.fetch?.provider === "string"
      ? params.config.tools.web.fetch.provider
      : undefined;
  const webFetchPluginId = resolvePluginIdForConfiguredWebFetchProvider(
    webFetchProvider,
    params.env,
  );
  if (webFetchPluginId) {
    changes.push({
      pluginId: webFetchPluginId,
      kind: "web-fetch-provider-selected",
      providerId: normalizeOptionalLowercaseString(webFetchProvider) ?? "",
    });
  }

  for (const plugin of resolveProviderPluginsWithOwnedWebSearch(params.registry)) {
    const pluginId = plugin.id;
    if (hasPluginOwnedWebSearchConfig(params.config, pluginId)) {
      changes.push({ pluginId, kind: "plugin-web-search-configured" });
    }
  }

  for (const plugin of resolvePluginsWithOwnedToolConfig(params.registry)) {
    const pluginId = plugin.id;
    if (hasPluginOwnedToolConfig(params.config, plugin)) {
      changes.push({ pluginId, kind: "plugin-tool-configured" });
    }
  }

  for (const plugin of resolveProviderPluginsWithOwnedWebFetch(params.registry)) {
    const pluginId = plugin.id;
    if (hasPluginOwnedWebFetchConfig(params.config, pluginId)) {
      changes.push({ pluginId, kind: "plugin-web-fetch-configured" });
    }
  }

  if (hasSetupAutoEnableRelevantConfig(params.config)) {
    for (const entry of resolvePluginSetupAutoEnableReasons({
      config: params.config,
      env: params.env,
    })) {
      changes.push({
        pluginId: entry.pluginId,
        kind: "setup-auto-enable",
        reason: entry.reason,
      });
    }
  }

  return changes;
}

function isPluginExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const channelConfig = channels?.[builtInChannelId];
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    ) {
      return true;
    }
  }
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

function isBuiltInChannelAlreadyEnabled(cfg: OpenClawConfig, channelId: string): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = channels?.[channelId];
  return (
    !!channelConfig &&
    typeof channelConfig === "object" &&
    !Array.isArray(channelConfig) &&
    (channelConfig as { enabled?: unknown }).enabled === true
  );
}

function registerPluginEntry(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const existing = channels?.[builtInChannelId];
    const existingRecord =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [builtInChannelId]: {
          ...existingRecord,
          enabled: true,
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [pluginId]: {
          ...(cfg.plugins?.entries?.[pluginId] as Record<string, unknown> | undefined),
          enabled: true,
        },
      },
    },
  };
}

function hasMaterialPluginEntryConfig(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return (
    entry.enabled === true ||
    isRecord(entry.config) ||
    isRecord(entry.hooks) ||
    isRecord(entry.subagent) ||
    entry.apiKey !== undefined ||
    entry.env !== undefined
  );
}

function isKnownPluginId(pluginId: string, manifestRegistry: PluginManifestRegistry): boolean {
  if (normalizeChatChannelId(pluginId)) {
    return true;
  }
  return manifestRegistry.plugins.some((plugin) => plugin.id === pluginId);
}

function materializeConfiguredPluginEntryAllowlist(params: {
  config: OpenClawConfig;
  changes: string[];
  manifestRegistry: PluginManifestRegistry;
}): OpenClawConfig {
  let next = params.config;
  const allow = next.plugins?.allow;
  const entries = next.plugins?.entries;
  if (!Array.isArray(allow) || allow.length === 0 || !entries || typeof entries !== "object") {
    return next;
  }

  for (const pluginId of Object.keys(entries).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const entry = entries[pluginId];
    if (
      !hasMaterialPluginEntryConfig(entry) ||
      isPluginDenied(next, pluginId) ||
      isPluginExplicitlyDisabled(next, pluginId) ||
      allow.includes(pluginId) ||
      !isKnownPluginId(pluginId, params.manifestRegistry)
    ) {
      continue;
    }
    next = ensurePluginAllowlisted(next, pluginId);
    params.changes.push(`${pluginId} plugin config present, added to plugin allowlist.`);
  }

  return next;
}

function resolveChannelAutoEnableDisplayLabel(
  entry: Extract<PluginAutoEnableCandidate, { kind: "channel-configured" }>,
  manifestRegistry: PluginManifestRegistry,
): string | undefined {
  const builtInChannelId = normalizeChatChannelId(entry.channelId);
  if (builtInChannelId) {
    return getChatChannelMeta(builtInChannelId).label;
  }
  const plugin = manifestRegistry.plugins.find((record) => record.id === entry.pluginId);
  return plugin?.channelConfigs?.[entry.channelId]?.label ?? plugin?.channelCatalogMeta?.label;
}

function formatAutoEnableChange(
  entry: PluginAutoEnableCandidate,
  manifestRegistry: PluginManifestRegistry,
): string {
  if (entry.kind === "channel-configured") {
    const label = resolveChannelAutoEnableDisplayLabel(entry, manifestRegistry);
    if (label) {
      return `${label} configured, enabled automatically.`;
    }
  }
  return `${resolvePluginAutoEnableCandidateReason(entry).trim()}, enabled automatically.`;
}

export function resolvePluginAutoEnableManifestRegistry(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginManifestRegistry {
  return (
    params.manifestRegistry ??
    (configMayNeedPluginManifestRegistry(params.config, params.env)
      ? loadPluginManifestRegistry({ config: params.config, env: params.env })
      : EMPTY_PLUGIN_MANIFEST_REGISTRY)
  );
}

export function materializePluginAutoEnableCandidatesInternal(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
}): PluginAutoEnableResult {
  let next = params.config ?? {};
  const changes: string[] = [];
  const autoEnabledReasons = new Map<string, string[]>();

  if (next.plugins?.enabled === false) {
    return { config: next, changes, autoEnabledReasons: {} };
  }

  const preferOverCache = new Map<string, string[]>();

  for (const entry of params.candidates) {
    const builtInChannelId = normalizeChatChannelId(entry.pluginId);
    if (isPluginDenied(next, entry.pluginId) || isPluginExplicitlyDisabled(next, entry.pluginId)) {
      continue;
    }
    if (
      shouldSkipPreferredPluginAutoEnable({
        config: next,
        entry,
        configured: params.candidates,
        env: params.env,
        registry: params.manifestRegistry,
        isPluginDenied,
        isPluginExplicitlyDisabled,
        preferOverCache,
      })
    ) {
      continue;
    }

    const allow = next.plugins?.allow;
    const allowMissing = Array.isArray(allow) && !allow.includes(entry.pluginId);
    const alreadyEnabled =
      builtInChannelId != null
        ? isBuiltInChannelAlreadyEnabled(next, builtInChannelId)
        : next.plugins?.entries?.[entry.pluginId]?.enabled === true;
    if (alreadyEnabled && !allowMissing) {
      continue;
    }

    next = registerPluginEntry(next, entry.pluginId);
    next = ensurePluginAllowlisted(next, entry.pluginId);
    const reason = resolvePluginAutoEnableCandidateReason(entry);
    autoEnabledReasons.set(entry.pluginId, [
      ...(autoEnabledReasons.get(entry.pluginId) ?? []),
      reason,
    ]);
    changes.push(formatAutoEnableChange(entry, params.manifestRegistry));
  }

  next = materializeConfiguredPluginEntryAllowlist({
    config: next,
    changes,
    manifestRegistry: params.manifestRegistry,
  });

  const autoEnabledReasonRecord: Record<string, string[]> = Object.create(null);
  for (const [pluginId, reasons] of autoEnabledReasons) {
    if (!isBlockedObjectKey(pluginId)) {
      autoEnabledReasonRecord[pluginId] = [...reasons];
    }
  }

  return { config: next, changes, autoEnabledReasons: autoEnabledReasonRecord };
}
