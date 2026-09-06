// Shares plugin auto-enable detection across config and runtime code.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { collectConfiguredSpeechProviderIds } from "../plugins/gateway-startup-speech-providers.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveOwningPluginIdsForModelRef } from "../plugins/providers.js";
import { resolvePluginSetupAutoEnableReasons } from "../plugins/setup-registry.js";
import { collectConfiguredWorkerProviderIds } from "../plugins/worker-provider-config.js";
import { listBundledWorkerProviderOwners } from "../plugins/worker-provider-manifest.js";
import {
  collectAutoEnableChannelIds,
  resolveConfiguredChannelAutoEnableCandidates,
  type ConfiguredPluginAutoEnableParams,
} from "./plugin-auto-enable.channels.js";
import { hasMaterialPluginEntryConfig } from "./plugin-auto-enable.materialize.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import { resolveConfiguredTalkRealtimeProviderId } from "./talk.js";
import type { OpenClawConfig } from "./types.openclaw.js";

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

function canReuseUnscopedCurrentPluginMetadataSnapshot(config: OpenClawConfig): boolean {
  return normalizePluginsConfig(config.plugins).loadPaths.length === 0;
}

function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}

function hasConfiguredEmbeddedHarnessRuntime(
  cfg: OpenClawConfig,
  _env: NodeJS.ProcessEnv,
): boolean {
  return collectConfiguredAgentHarnessRuntimes(cfg).length > 0;
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

  for (const { value: ref } of collectConfiguredModelRefs(cfg, {
    includeChannelModelOverrides: false,
  })) {
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

function resolvePluginIdsForConfiguredSpeechProvider(
  providerId: string,
  registry: PluginManifestRegistry,
): string[] {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return [];
  }
  return registry.plugins
    .filter((plugin) =>
      (plugin.contracts?.speechProviders ?? []).some(
        (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
      ),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
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

function resolvePluginIdForConfiguredWebSearchProvider(
  providerId: string | undefined,
  registry: PluginManifestRegistry,
): string | undefined {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  return registry.plugins.find((plugin) =>
    (plugin.contracts?.webSearchProviders ?? []).some(
      (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
    ),
  )?.id;
}

function hasConfiguredWebSearchProviderSelection(cfg: OpenClawConfig): boolean {
  const provider = cfg.tools?.web?.search?.provider;
  return (
    cfg.tools?.web?.search?.enabled !== false &&
    typeof provider === "string" &&
    Boolean(provider.trim())
  );
}

function hasConfiguredVoiceProviderSelection(cfg: OpenClawConfig): boolean {
  return Boolean(
    collectConfiguredSpeechProviderIds(cfg).size || resolveConfiguredTalkRealtimeProviderId(cfg),
  );
}

function hasConfiguredPluginConfigEntry(
  cfg: OpenClawConfig,
  configKey?: "webSearch" | "webFetch",
): boolean {
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  return (
    entries !== undefined &&
    Object.values(entries).some(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.config) &&
        (configKey === undefined || isRecord(entry.config[configKey])),
    )
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
  return listAgentEntries(cfg).some((entry) => toolPolicyReferencesBrowser(entry.tools));
}

function collectConfiguredPluginEntryIds(cfg: OpenClawConfig): string[] {
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  if (!entries) {
    return [];
  }
  return Object.keys(entries)
    .map((pluginId) => pluginId.trim())
    .filter((pluginId) => pluginId && !isPluginEntryExplicitlyDisabled(cfg, pluginId));
}

function hasOwnPluginEntry(cfg: OpenClawConfig, pluginId: string): boolean {
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  return entries !== undefined && Object.hasOwn(entries, pluginId);
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
    isRecord(pluginConfig) &&
    (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution))
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
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  return entries !== undefined && Object.keys(entries).length > 0;
}

function hasPluginAllowlistWithMaterialEntries(cfg: OpenClawConfig): boolean {
  if (
    !Array.isArray(cfg.plugins?.allow) ||
    cfg.plugins.allow.length === 0 ||
    !hasPluginEntries(cfg)
  ) {
    return false;
  }
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  if (!entries) {
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
  if (collectConfiguredModelRefs(cfg, { includeChannelModelOverrides: false }).length > 0) {
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
  if (hasConfiguredVoiceProviderSelection(cfg)) {
    return true;
  }
  if (collectConfiguredWorkerProviderIds(cfg).length > 0) {
    return true;
  }
  if (hasConfiguredWebSearchProviderSelection(cfg)) {
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
  return resolvePluginAutoEnableReadiness(cfg, env).mayNeedAutoEnable;
}

export function resolvePluginAutoEnableReadiness(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  discovery?: PluginDiscoveryResult,
  ambientEnvTriggers: AmbientEnvTriggerPolicy = "allow",
): { mayNeedAutoEnable: boolean; configuredChannelIds: string[] } {
  if (arePluginsGloballyDisabled(cfg)) {
    return { mayNeedAutoEnable: false, configuredChannelIds: [] };
  }
  const configuredChannelIds = collectAutoEnableChannelIds(cfg, env, discovery, ambientEnvTriggers);
  if (hasPluginAllowlistWithMaterialEntries(cfg)) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (hasConfiguredPluginConfigEntry(cfg)) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (configuredChannelIds.length > 0) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (hasConfiguredProviderModelOrHarness(cfg, env)) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (hasConfiguredVoiceProviderSelection(cfg)) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (collectConfiguredWorkerProviderIds(cfg).length > 0) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (
    hasConfiguredWebSearchProviderSelection(cfg) ||
    hasConfiguredPluginConfigEntry(cfg, "webSearch") ||
    hasConfiguredPluginConfigEntry(cfg, "webFetch")
  ) {
    return { mayNeedAutoEnable: true, configuredChannelIds };
  }
  if (!hasSetupAutoEnableRelevantConfig(cfg)) {
    return { mayNeedAutoEnable: false, configuredChannelIds };
  }
  return {
    mayNeedAutoEnable:
      resolvePluginSetupAutoEnableReasons({
        config: cfg,
        env,
        pluginIds: resolveRelevantSetupAutoEnablePluginIds(cfg),
      }).length > 0,
    configuredChannelIds,
  };
}

export function resolveConfiguredPluginAutoEnableCandidates(
  params: ConfiguredPluginAutoEnableParams,
): PluginAutoEnableCandidate[] {
  const changes = resolveConfiguredChannelAutoEnableCandidates(params);

  for (const [providerId, pluginId] of Object.entries(
    resolveAutoEnableProviderPluginIds(params.registry),
  )) {
    if (isProviderConfigured(params.config, providerId)) {
      changes.push({ pluginId, kind: "provider-auth-configured", providerId });
    }
  }

  const configuredModelPluginIds = new Set<string>();
  for (const modelRef of new Set(
    collectConfiguredModelRefs(params.config, { includeChannelModelOverrides: false }).map(
      ({ value }) => value,
    ),
  )) {
    const owningPluginIds = resolveOwningPluginIdsForModelRef({
      model: modelRef,
      config: params.config,
      env: params.env,
      manifestRegistry: params.registry,
    });
    const pluginId = owningPluginIds?.length === 1 ? owningPluginIds[0] : undefined;
    if (!pluginId || configuredModelPluginIds.has(pluginId)) {
      continue;
    }
    configuredModelPluginIds.add(pluginId);
    changes.push({ pluginId, kind: "provider-model-configured", modelRef });
  }

  for (const providerId of collectConfiguredSpeechProviderIds(params.config)) {
    for (const pluginId of resolvePluginIdsForConfiguredSpeechProvider(
      providerId,
      params.registry,
    )) {
      changes.push({
        pluginId,
        kind: "speech-provider-selected",
        providerId,
      });
    }
  }

  const realtimeProviderId = resolveConfiguredTalkRealtimeProviderId(params.config);
  if (realtimeProviderId) {
    for (const plugin of params.registry.plugins) {
      if (!plugin.contracts?.realtimeVoiceProviders?.includes(realtimeProviderId.toLowerCase())) {
        continue;
      }
      changes.push({
        pluginId: plugin.id,
        kind: "setup-auto-enable",
        reason: `${realtimeProviderId} realtime voice provider selected`,
      });
    }
  }

  for (const { pluginId, providerId } of listBundledWorkerProviderOwners(
    params.registry,
    collectConfiguredWorkerProviderIds(params.config),
  )) {
    changes.push({ pluginId, kind: "worker-provider-selected", providerId });
  }

  for (const runtime of collectConfiguredAgentHarnessRuntimes(params.config)) {
    const pluginIds = resolveAgentHarnessOwnerPluginIds(params.registry, runtime);
    for (const pluginId of pluginIds) {
      changes.push({
        pluginId,
        kind: "agent-harness-runtime-configured",
        runtime,
      });
    }
  }

  const webSearchConfig = params.config.tools?.web?.search;
  const webSearchProvider =
    webSearchConfig?.enabled !== false && typeof webSearchConfig?.provider === "string"
      ? webSearchConfig.provider
      : undefined;
  const webSearchPluginId = resolvePluginIdForConfiguredWebSearchProvider(
    webSearchProvider,
    params.registry,
  );
  if (webSearchPluginId) {
    changes.push({
      pluginId: webSearchPluginId,
      kind: "web-search-provider-selected",
      providerId: normalizeOptionalLowercaseString(webSearchProvider) ?? "",
    });
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
      manifestRegistry: params.registry,
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

export function resolvePluginAutoEnableManifestRegistry(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginManifestRegistry {
  if (params.manifestRegistry) {
    return params.manifestRegistry;
  }
  if (!configMayNeedPluginManifestRegistry(params.config, params.env)) {
    return EMPTY_PLUGIN_MANIFEST_REGISTRY;
  }
  const currentSnapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env,
    allowWorkspaceScopedSnapshot: true,
  });
  const policyCompatibleCurrentSnapshot =
    currentSnapshot ??
    (() => {
      if (!canReuseUnscopedCurrentPluginMetadataSnapshot(params.config)) {
        return undefined;
      }
      const snapshot = getCurrentPluginMetadataSnapshot({
        env: params.env,
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      });
      return snapshot?.policyHash === resolveInstalledPluginIndexPolicyHash(params.config)
        ? snapshot
        : undefined;
    })();
  return (
    policyCompatibleCurrentSnapshot?.manifestRegistry ??
    loadPluginMetadataSnapshot({
      config: params.config,
      env: params.env,
    }).manifestRegistry
  );
}
