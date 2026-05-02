import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import {
  hasPotentialConfiguredChannels,
  listPotentialConfiguredChannelPresenceSignals,
} from "../channels/config-presence.js";
import { getChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import {
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
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
  const collectModelConfig = (value: unknown) => {
    if (typeof value === "string") {
      pushModelRef(value);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    pushModelRef(value.primary);
    const fallbacks = value.fallbacks;
    if (Array.isArray(fallbacks)) {
      for (const entry of fallbacks) {
        pushModelRef(entry);
      }
    }
  };
  const collectFromAgent = (agent: Record<string, unknown> | null | undefined) => {
    if (!agent) {
      return;
    }
    for (const key of [
      "model",
      "imageGenerationModel",
      "videoGenerationModel",
      "musicGenerationModel",
    ]) {
      collectModelConfig(agent[key]);
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
      [...(plugin.activation?.onAgentHarnesses ?? []), ...(plugin.cliBackends ?? [])].some(
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
  registry: PluginManifestRegistry,
): string | undefined {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  return registry.plugins.find(
    (plugin) =>
      plugin.origin === "bundled" &&
      (plugin.contracts?.webFetchProviders ?? []).some(
        (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
      ),
  )?.id;
}

function normalizeManifestChannelId(channelId: string): string {
  return normalizeChatChannelId(channelId) ?? channelId;
}

function getManifestChannelPreferOver(
  plugin: PluginManifestRecord,
  channelId: string,
): readonly string[] {
  return plugin.channelConfigs?.[channelId]?.preferOver ?? [];
}

function collectPluginIdsForConfiguredChannel(
  channelId: string,
  registry: PluginManifestRegistry,
): string[] {
  const normalizedChannelId = normalizeManifestChannelId(channelId);
  const builtInId = normalizeChatChannelId(normalizedChannelId);
  const claims: Array<{ plugin: PluginManifestRecord; preferOver: readonly string[] }> = [];
  for (const record of registry.plugins) {
    if (
      (record.channels ?? []).some((id) => normalizeManifestChannelId(id) === normalizedChannelId)
    ) {
      claims.push({
        plugin: record,
        preferOver: getManifestChannelPreferOver(record, normalizedChannelId),
      });
    }
  }

  if (claims.length === 0) {
    return [builtInId ?? normalizedChannelId];
  }

  const claimIds = new Set(claims.map((claim) => claim.plugin.id));
  if (builtInId) {
    claimIds.add(builtInId);
  }
  const preferredIds = new Set<string>();
  for (const claim of claims) {
    for (const preferredOverId of claim.preferOver) {
      if (claimIds.has(preferredOverId)) {
        // Keep both sides as candidates. The preferOver filter later disables
        // the lower-priority plugin unless the preferred plugin is explicitly
        // disabled/denied, preserving fallback to bundled channel support.
        preferredIds.add(claim.plugin.id);
        preferredIds.add(preferredOverId);
      }
    }
  }

  if (preferredIds.size > 0) {
    return [...preferredIds].toSorted((left, right) => left.localeCompare(right));
  }
  return [builtInId ?? claims[0]?.plugin.id ?? normalizedChannelId];
}

function collectConfiguredChannelIds(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  return listPotentialConfiguredChannelPresenceSignals(cfg, env, {
    includePersistedAuthState: false,
  })
    .map((signal) => normalizeChatChannelId(signal.channelId) ?? signal.channelId)
    .filter((channelId) => isChannelConfigured(cfg, channelId, env));
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

function collectConfiguredPluginEntryIds(cfg: OpenClawConfig): string[] {
  const entries = cfg.plugins?.entries;
  if (!entries || typeof entries !== "object") {
    return [];
  }
  return Object.keys(entries)
    .map((pluginId) => pluginId.trim())
    .filter((pluginId) => pluginId && !isPluginEntryExplicitlyDisabled(cfg, pluginId));
}

function hasOwnPluginEntry(cfg: OpenClawConfig, pluginId: string): boolean {
  const entries = cfg.plugins?.entries;
  return !!entries && typeof entries === "object" && Object.hasOwn(entries, pluginId);
}

function isPluginEntryExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

function hasNonDisabledPluginEntry(cfg: OpenClawConfig, pluginId: string): boolean {
  if (!hasOwnPluginEntry(cfg, pluginId)) {
    return false;
  }
  return !isPluginEntryExplicitlyDisabled(cfg, pluginId);
}

function hasBrowserSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (cfg.browser?.enabled === false || isPluginEntryExplicitlyDisabled(cfg, "browser")) {
    return false;
  }
  if (isRecord(cfg.browser)) {
    return true;
  }
  if (hasNonDisabledPluginEntry(cfg, "browser")) {
    return true;
  }
  return hasBrowserToolReference(cfg);
}

function hasAcpxSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (isPluginEntryExplicitlyDisabled(cfg, "acpx")) {
    return false;
  }
  if (!isRecord(cfg.acp)) {
    return false;
  }
  const backend = normalizeOptionalLowercaseString(cfg.acp.backend);
  const configured =
    cfg.acp.enabled === true ||
    (isRecord(cfg.acp.dispatch) && cfg.acp.dispatch.enabled === true) ||
    backend === "acpx";
  return configured && (!backend || backend === "acpx");
}

function hasXaiSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (isPluginEntryExplicitlyDisabled(cfg, "xai")) {
    return false;
  }
  const pluginConfig = cfg.plugins?.entries?.xai?.config;
  return (
    (isRecord(pluginConfig) &&
      (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution))) ||
    (isRecord(cfg.tools?.web) && isRecord((cfg.tools.web as Record<string, unknown>).x_search))
  );
}

function resolveRelevantSetupAutoEnablePluginIds(cfg: OpenClawConfig): string[] {
  const pluginIds = new Set<string>(collectConfiguredPluginEntryIds(cfg));
  if (hasBrowserSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("browser");
  }
  if (hasAcpxSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("acpx");
  }
  if (hasXaiSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("xai");
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

function hasSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  return (
    hasBrowserSetupAutoEnableRelevantConfig(cfg) ||
    hasAcpxSetupAutoEnableRelevantConfig(cfg) ||
    hasXaiSetupAutoEnableRelevantConfig(cfg) ||
    hasConfiguredPluginConfigEntry(cfg)
  );
}

function hasPluginEntries(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  return !!entries && typeof entries === "object" && Object.keys(entries).length > 0;
}

function hasPluginAllowlistWithMaterialEntries(cfg: OpenClawConfig): boolean {
  if (
    !Array.isArray(cfg.plugins?.allow) ||
    cfg.plugins.allow.length === 0 ||
    !hasPluginEntries(cfg)
  ) {
    return false;
  }
  const entries = cfg.plugins?.entries;
  if (!entries || typeof entries !== "object") {
    return false;
  }
  return Object.values(entries).some(hasMaterialPluginEntryConfig);
}

function hasConfiguredProviderModelOrHarness(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) {
    return true;
  }
  if (cfg.models?.providers && Object.keys(cfg.models.providers).length > 0) {
    return true;
  }
  if (collectModelRefs(cfg).length > 0) {
    return true;
  }
  return hasConfiguredEmbeddedHarnessRuntime(cfg, env);
}

function arePluginsGloballyDisabled(cfg: OpenClawConfig): boolean {
  return cfg.plugins?.enabled === false;
}

function configMayNeedPluginManifestRegistry(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (arePluginsGloballyDisabled(cfg)) {
    return false;
  }
  if (hasPluginAllowlistWithMaterialEntries(cfg)) {
    return true;
  }
  if (hasConfiguredPluginConfigEntry(cfg)) {
    return true;
  }
  if (hasConfiguredProviderModelOrHarness(cfg, env)) {
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
    return true;
  }
  return false;
}

export function configMayNeedPluginAutoEnable(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  if (arePluginsGloballyDisabled(cfg)) {
    return false;
  }
  if (hasPluginAllowlistWithMaterialEntries(cfg)) {
    return true;
  }
  if (hasConfiguredPluginConfigEntry(cfg)) {
    return true;
  }
  if (hasPotentialConfiguredChannels(cfg, env, { includePersistedAuthState: false })) {
    return true;
  }
  if (hasConfiguredProviderModelOrHarness(cfg, env)) {
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
      pluginIds: resolveRelevantSetupAutoEnablePluginIds(cfg),
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
      return `${candidate.runtime} agent runtime configured`;
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
  for (const channelId of collectConfiguredChannelIds(params.config, params.env)) {
    for (const pluginId of collectPluginIdsForConfiguredChannel(channelId, params.registry)) {
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
    params.registry,
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
    const manifestMatchedPluginIds = new Set(changes.map((entry) => entry.pluginId));
    const setupPluginIds = resolveRelevantSetupAutoEnablePluginIds(params.config).filter(
      (pluginId) => !manifestMatchedPluginIds.has(pluginId),
    );
    for (const entry of resolvePluginSetupAutoEnableReasons({
      config: params.config,
      env: params.env,
      pluginIds: setupPluginIds,
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

function isPluginExplicitlySelected(cfg: OpenClawConfig, pluginId: string): boolean {
  const allow = cfg.plugins?.allow;
  if (Array.isArray(allow) && allow.includes(pluginId)) {
    return true;
  }
  return hasMaterialPluginEntryConfig(cfg.plugins?.entries?.[pluginId]);
}

function disableImplicitPreferredOverPlugin(params: {
  config: OpenClawConfig;
  originalConfig: OpenClawConfig;
  pluginId: string;
  manifestRegistry: PluginManifestRegistry;
}): OpenClawConfig {
  if (isPluginExplicitlySelected(params.originalConfig, params.pluginId)) {
    return params.config;
  }
  if (
    !normalizeChatChannelId(params.pluginId) &&
    !isKnownPluginId(params.pluginId, params.manifestRegistry)
  ) {
    return params.config;
  }
  const existingEntry = params.config.plugins?.entries?.[params.pluginId];
  return {
    ...params.config,
    plugins: {
      ...params.config.plugins,
      entries: {
        ...params.config.plugins?.entries,
        [params.pluginId]: {
          ...(existingEntry && typeof existingEntry === "object" ? existingEntry : {}),
          enabled: false,
        },
      },
    },
  };
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
    return getChatChannelMeta(builtInChannelId)?.label;
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
      ? loadPluginMetadataSnapshot({
          config: params.config,
          env: params.env,
        }).manifestRegistry
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
      next = disableImplicitPreferredOverPlugin({
        config: next,
        originalConfig: params.config ?? {},
        pluginId: entry.pluginId,
        manifestRegistry: params.manifestRegistry,
      });
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
