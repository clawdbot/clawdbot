import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";
import { resolvePluginWebFetchProviders } from "../plugins/web-fetch-providers.runtime.js";
import { sortWebFetchProvidersForAutoDetect } from "../plugins/web-fetch-providers.shared.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { normalizeOptionalAccountId } from "../routing/session-key.js";
import { loadChannelSecretContractApi } from "../secrets/channel-contract-api.js";
import {
  discoverConfigSecretTargetsByIds,
  listSecretTargetRegistryEntries,
} from "../secrets/target-registry.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const STATIC_QR_REMOTE_TARGET_IDS = ["gateway.remote.token", "gateway.remote.password"] as const;
const STATIC_MODEL_TARGET_IDS = [
  "models.providers.*.apiKey",
  "models.providers.*.headers.*",
  "models.providers.*.request.headers.*",
  "models.providers.*.request.auth.token",
  "models.providers.*.request.auth.value",
  "models.providers.*.request.proxy.tls.ca",
  "models.providers.*.request.proxy.tls.cert",
  "models.providers.*.request.proxy.tls.key",
  "models.providers.*.request.proxy.tls.passphrase",
  "models.providers.*.request.tls.ca",
  "models.providers.*.request.tls.cert",
  "models.providers.*.request.tls.key",
  "models.providers.*.request.tls.passphrase",
] as const;
const STATIC_AGENT_RUNTIME_BASE_TARGET_IDS = [
  ...STATIC_MODEL_TARGET_IDS,
  "agents.defaults.memorySearch.remote.apiKey",
  "agents.list[].memorySearch.remote.apiKey",
  "agents.list[].tts.providers.*.apiKey",
  "messages.tts.providers.*.apiKey",
  "skills.entries.*.apiKey",
  "tools.web.search.apiKey",
  "tools.web.fetch.firecrawl.apiKey",
] as const;
const STATIC_MEMORY_EMBEDDING_TARGET_IDS = [
  ...STATIC_MODEL_TARGET_IDS,
  "agents.defaults.memorySearch.remote.apiKey",
  "agents.list[].memorySearch.remote.apiKey",
] as const;
const STATIC_TTS_TARGET_IDS = [
  ...STATIC_MODEL_TARGET_IDS,
  "agents.list[].tts.providers.*.apiKey",
  "messages.tts.providers.*.apiKey",
] as const;
const STATIC_STATUS_TARGET_IDS = [
  "agents.defaults.memorySearch.remote.apiKey",
  "agents.list[].memorySearch.remote.apiKey",
] as const;
const STATIC_SECURITY_AUDIT_TARGET_IDS = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
] as const;

function idsByPrefix(prefixes: readonly string[]): string[] {
  return listSecretTargetRegistryEntries()
    .map((entry) => entry.id)
    .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)))
    .toSorted();
}

type CommandSecretTargets = {
  channels: string[];
  agentRuntime: string[];
  status: string[];
  securityAudit: string[];
};
type CommandSecretTargetScope = {
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
  forcedActivePaths?: Set<string>;
  optionalActivePaths?: Set<string>;
};
type SelectedProviderTargetIds = {
  matchedProvider: boolean;
  targetIds: string[];
  targetPaths: string[];
  allowedPaths: string[];
  fallbackTargetIds: string[];
  fallbackPaths: string[];
};

const STATIC_CAPABILITY_WEB_SEARCH_TARGET_IDS = [
  "tools.web.search.apiKey",
  "tools.web.search.*.apiKey",
] as const;
const STATIC_CAPABILITY_WEB_FETCH_TARGET_IDS = ["tools.web.fetch.firecrawl.apiKey"] as const;

let cachedCommandSecretTargets: CommandSecretTargets | undefined;
let cachedAgentRuntimeBaseTargetIds: string[] | undefined;
let cachedCapabilityWebFetchTargetIds: string[] | undefined;
let cachedCapabilityWebSearchTargetIds: string[] | undefined;
let cachedChannelSecretTargetIds: string[] | undefined;

function getChannelSecretTargetIds(): string[] {
  cachedChannelSecretTargetIds ??= idsByPrefix(["channels."]);
  return cachedChannelSecretTargetIds;
}

function isPluginWebCredentialTargetId(id: string): boolean {
  const segments = id.split(".");
  if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") {
    return false;
  }
  const configPath = segments.slice(4).join(".");
  return configPath === "webSearch.apiKey" || configPath === "webFetch.apiKey";
}

function isPluginWebSearchCredentialTargetId(id: string): boolean {
  const segments = id.split(".");
  if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") {
    return false;
  }
  return segments.slice(4).join(".") === "webSearch.apiKey";
}

function isPluginWebFetchCredentialTargetId(id: string): boolean {
  const segments = id.split(".");
  if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") {
    return false;
  }
  return segments.slice(4).join(".") === "webFetch.apiKey";
}

function getCapabilityWebSearchTargetIds(): string[] {
  cachedCapabilityWebSearchTargetIds ??= [
    ...new Set([
      ...STATIC_CAPABILITY_WEB_SEARCH_TARGET_IDS,
      ...listSecretTargetRegistryEntries()
        .map((entry) => entry.id)
        .filter(isPluginWebSearchCredentialTargetId),
    ]),
  ].toSorted();
  return cachedCapabilityWebSearchTargetIds;
}

function getCapabilityWebFetchTargetIds(): string[] {
  cachedCapabilityWebFetchTargetIds ??= [
    ...new Set([
      ...STATIC_CAPABILITY_WEB_FETCH_TARGET_IDS,
      ...listSecretTargetRegistryEntries()
        .map((entry) => entry.id)
        .filter(isPluginWebFetchCredentialTargetId),
    ]),
  ].toSorted();
  return cachedCapabilityWebFetchTargetIds;
}

function isConfiguredSecretCandidate(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function resolveFetchConfig(config: OpenClawConfig): Record<string, unknown> | undefined {
  const fetch = config.tools?.web?.fetch;
  return fetch && typeof fetch === "object" && !Array.isArray(fetch)
    ? (fetch as Record<string, unknown>)
    : undefined;
}

function resolveSearchConfig(config: OpenClawConfig): Record<string, unknown> | undefined {
  const search = config.tools?.web?.search;
  return search && typeof search === "object" && !Array.isArray(search)
    ? (search as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathPatternMatchesConcretePath(pathPattern: string, path: string): boolean {
  const pathSegments = path.split(".");
  const patternSegments = pathPattern.split(".");
  let pathIndex = 0;
  for (const segment of patternSegments) {
    if (segment === "*") {
      if (!pathSegments[pathIndex]) {
        return false;
      }
      pathIndex += 1;
      continue;
    }
    if (segment.endsWith("[]")) {
      const field = segment.slice(0, -2);
      if (pathSegments[pathIndex] !== field || !/^\d+$/.test(pathSegments[pathIndex + 1] ?? "")) {
        return false;
      }
      pathIndex += 2;
      continue;
    }
    if (pathSegments[pathIndex] !== segment) {
      return false;
    }
    pathIndex += 1;
  }
  return pathIndex === pathSegments.length;
}

function targetIdsForConfigPath(path: string): string[] {
  return listSecretTargetRegistryEntries()
    .filter((entry) => pathPatternMatchesConcretePath(entry.pathPattern ?? entry.id, path))
    .map((entry) => entry.id)
    .toSorted();
}

function addConfigPathTargets(params: {
  path: string;
  targetIds: Set<string>;
  targetPaths: Set<string>;
  allowedPaths: Set<string>;
}): boolean {
  const targetIds = targetIdsForConfigPath(params.path);
  if (targetIds.length === 0) {
    return false;
  }
  for (const targetId of targetIds) {
    params.targetIds.add(targetId);
    if (targetId !== params.path) {
      params.allowedPaths.add(params.path);
    }
  }
  params.targetPaths.add(params.path);
  return true;
}

function addConfiguredConfigPathTargets(params: {
  config: OpenClawConfig;
  path: string;
  targetIds: Set<string>;
  targetPaths: Set<string>;
  allowedPaths: Set<string>;
}): boolean {
  const targetIds = targetIdsForConfigPath(params.path);
  if (targetIds.length === 0) {
    return false;
  }
  const discovered = discoverConfigSecretTargetsByIds(params.config, toTargetIdSet(targetIds));
  if (!discovered.some((target) => target.path === params.path)) {
    return false;
  }
  return addConfigPathTargets(params);
}

function normalizeProviderId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function modelProviderCredentialFallbackPathForWebSearchProvider(
  providerId: string | undefined,
): string | undefined {
  switch (providerId) {
    case "gemini":
      return "models.providers.google.apiKey";
    case "ollama":
      return "models.providers.ollama.apiKey";
    default:
      return undefined;
  }
}

function discoverForcedActivePaths(
  config: OpenClawConfig,
  targetIds: ReadonlySet<string>,
  allowedPaths?: ReadonlySet<string>,
): Set<string> | undefined {
  const forcedActivePaths = new Set<string>();
  for (const target of discoverConfigSecretTargetsByIds(config, targetIds)) {
    if (allowedPaths && !allowedPaths.has(target.path)) {
      continue;
    }
    forcedActivePaths.add(target.path);
  }
  return forcedActivePaths.size > 0 ? forcedActivePaths : undefined;
}

function discoverConfiguredAllowedPaths(
  config: OpenClawConfig,
  targetIds: ReadonlySet<string>,
): Set<string> | undefined {
  const allowedPaths = new Set<string>();
  for (const target of discoverConfigSecretTargetsByIds(config, targetIds)) {
    allowedPaths.add(target.path);
  }
  return allowedPaths.size > 0 ? allowedPaths : undefined;
}

function mergeConfiguredAllowedPaths(params: {
  config: OpenClawConfig;
  baseTargetIds: ReadonlySet<string>;
  concreteFallbackPaths: ReadonlySet<string>;
}): Set<string> | undefined {
  const allowedPaths = new Set<string>();
  for (const path of discoverConfiguredAllowedPaths(params.config, params.baseTargetIds) ?? []) {
    allowedPaths.add(path);
  }
  for (const path of params.concreteFallbackPaths) {
    allowedPaths.add(path);
  }
  return allowedPaths.size > 0 ? allowedPaths : undefined;
}

function resolveSelectedWebFetchProviderId(
  config: OpenClawConfig,
  providerId?: string | null,
): string | undefined {
  return (
    normalizeProviderId(providerId) ?? normalizeProviderId(resolveFetchConfig(config)?.provider)
  );
}

function resolveSelectedWebSearchProviderId(
  config: OpenClawConfig,
  providerId?: string | null,
): string | undefined {
  return (
    normalizeProviderId(providerId) ?? normalizeProviderId(resolveSearchConfig(config)?.provider)
  );
}

function withSelectedWebProviderForDiscovery(
  config: OpenClawConfig,
  kind: "search" | "fetch",
  providerId: string | undefined,
): OpenClawConfig {
  if (!providerId) {
    return config;
  }
  const next = structuredClone(config);
  const tools = (next.tools ??= {});
  const web = (tools.web ??= {});
  const existing = web[kind];
  web[kind] =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing, provider: providerId }
      : { provider: providerId };
  return next;
}

function hasConfiguredFetchCredential(params: {
  provider: PluginWebFetchProviderEntry;
  config: OpenClawConfig;
}): boolean {
  return (
    isConfiguredSecretCandidate(params.provider.getConfiguredCredentialValue?.(params.config)) ||
    isConfiguredSecretCandidate(
      params.provider.getCredentialValue(resolveFetchConfig(params.config)),
    )
  );
}

function hasConfiguredSearchCredential(params: {
  provider: PluginWebSearchProviderEntry;
  config: OpenClawConfig;
}): boolean {
  return (
    isConfiguredSecretCandidate(params.provider.getConfiguredCredentialValue?.(params.config)) ||
    isConfiguredSecretCandidate(
      params.provider.getCredentialValue(resolveSearchConfig(params.config)),
    )
  );
}

function addConfiguredSearchCredentialTargetIds(params: {
  config: OpenClawConfig;
  provider: PluginWebSearchProviderEntry;
  targetIds: Set<string>;
  targetPaths: Set<string>;
  allowedPaths: Set<string>;
}): void {
  const searchConfig = resolveSearchConfig(params.config);
  if (!searchConfig) {
    return;
  }
  const configuredCredential = params.provider.getCredentialValue(searchConfig);
  if (!isConfiguredSecretCandidate(configuredCredential)) {
    return;
  }
  const pluginCredential = params.provider.getConfiguredCredentialValue?.(params.config);
  if (isConfiguredSecretCandidate(pluginCredential) && configuredCredential !== pluginCredential) {
    return;
  }
  if (configuredCredential === searchConfig.apiKey) {
    addConfigPathTargets({ ...params, path: "tools.web.search.apiKey" });
  }
  const scopedConfig = searchConfig[params.provider.id];
  if (isRecord(scopedConfig) && configuredCredential === scopedConfig.apiKey) {
    addConfigPathTargets({
      ...params,
      path: `tools.web.search.${params.provider.id}.apiKey`,
    });
  }
}

function addConfiguredFetchCredentialTargetIds(params: {
  config: OpenClawConfig;
  provider: PluginWebFetchProviderEntry;
  targetIds: Set<string>;
  targetPaths: Set<string>;
  allowedPaths: Set<string>;
}): void {
  const fetchConfig = resolveFetchConfig(params.config);
  if (!fetchConfig) {
    return;
  }
  const configuredCredential = params.provider.getCredentialValue(fetchConfig);
  if (!isConfiguredSecretCandidate(configuredCredential)) {
    return;
  }
  const pluginCredential = params.provider.getConfiguredCredentialValue?.(params.config);
  if (isConfiguredSecretCandidate(pluginCredential) && configuredCredential !== pluginCredential) {
    return;
  }
  const scopedConfig = fetchConfig[params.provider.id];
  if (isRecord(scopedConfig) && configuredCredential === scopedConfig.apiKey) {
    addConfigPathTargets({
      ...params,
      path: `tools.web.fetch.${params.provider.id}.apiKey`,
    });
  }
}

function getCapabilityWebSearchSelectedProviderTargetIds(
  config: OpenClawConfig,
  providerId?: string | null,
): SelectedProviderTargetIds {
  const selectedProviderId = resolveSelectedWebSearchProviderId(config, providerId);
  if (!selectedProviderId) {
    return {
      matchedProvider: false,
      targetIds: [],
      targetPaths: [],
      allowedPaths: [],
      fallbackTargetIds: [],
      fallbackPaths: [],
    };
  }
  const targetIds = new Set<string>();
  const targetPaths = new Set<string>();
  const allowedPaths = new Set<string>();
  const fallbackTargetIds = new Set<string>();
  const fallbackPaths = new Set<string>();
  const providerDiscoveryConfig = withSelectedWebProviderForDiscovery(
    config,
    "search",
    normalizeProviderId(providerId),
  );
  const providers = resolvePluginWebSearchProviders({
    config: providerDiscoveryConfig,
    bundledAllowlistCompat: true,
  }).filter((provider) => provider.id === selectedProviderId);
  for (const provider of providers) {
    if (provider.credentialPath.trim()) {
      addConfigPathTargets({
        path: provider.credentialPath,
        targetIds,
        targetPaths,
        allowedPaths,
      });
    }
    addConfiguredSearchCredentialTargetIds({
      config,
      provider,
      targetIds,
      targetPaths,
      allowedPaths,
    });
    if (hasConfiguredSearchCredential({ provider, config })) {
      continue;
    }
    const fallbackPath = provider.getConfiguredCredentialFallback?.(config)?.path?.trim();
    if (fallbackPath) {
      const before = new Set(targetIds);
      const added = addConfigPathTargets({
        path: fallbackPath,
        targetIds,
        targetPaths,
        allowedPaths,
      });
      for (const targetId of targetIds) {
        if (!before.has(targetId)) {
          fallbackTargetIds.add(targetId);
        }
      }
      if (added) {
        fallbackPaths.add(fallbackPath);
      }
    }
    const modelFallbackPath =
      modelProviderCredentialFallbackPathForWebSearchProvider(selectedProviderId);
    if (modelFallbackPath && !fallbackPaths.has(modelFallbackPath)) {
      const before = new Set(targetIds);
      const added = addConfiguredConfigPathTargets({
        config,
        path: modelFallbackPath,
        targetIds,
        targetPaths,
        allowedPaths,
      });
      for (const targetId of targetIds) {
        if (!before.has(targetId)) {
          fallbackTargetIds.add(targetId);
        }
      }
      if (added) {
        fallbackPaths.add(modelFallbackPath);
      }
    }
  }
  return {
    matchedProvider: providers.length > 0,
    targetIds: [...targetIds].toSorted(),
    targetPaths: [...targetPaths].toSorted(),
    allowedPaths: [...allowedPaths].toSorted(),
    fallbackTargetIds: [...fallbackTargetIds].toSorted(),
    fallbackPaths: [...fallbackPaths].toSorted(),
  };
}

function getCapabilityWebFetchSelectedProviderTargetIds(
  config: OpenClawConfig,
  providerId?: string | null,
): SelectedProviderTargetIds {
  const selectedProviderId = resolveSelectedWebFetchProviderId(config, providerId);
  if (!selectedProviderId) {
    return {
      matchedProvider: false,
      targetIds: [],
      targetPaths: [],
      allowedPaths: [],
      fallbackTargetIds: [],
      fallbackPaths: [],
    };
  }
  const targetIds = new Set<string>();
  const targetPaths = new Set<string>();
  const allowedPaths = new Set<string>();
  const fallbackTargetIds = new Set<string>();
  const fallbackPaths = new Set<string>();
  const providerDiscoveryConfig = withSelectedWebProviderForDiscovery(
    config,
    "fetch",
    normalizeProviderId(providerId),
  );
  const providers = resolvePluginWebFetchProviders({
    config: providerDiscoveryConfig,
    bundledAllowlistCompat: true,
  }).filter((provider) => provider.id === selectedProviderId);
  for (const provider of providers) {
    if (provider.credentialPath.trim()) {
      addConfigPathTargets({
        path: provider.credentialPath,
        targetIds,
        targetPaths,
        allowedPaths,
      });
    }
    addConfiguredFetchCredentialTargetIds({
      config,
      provider,
      targetIds,
      targetPaths,
      allowedPaths,
    });
    if (hasConfiguredFetchCredential({ provider, config })) {
      continue;
    }
    const fallbackPath = provider.getConfiguredCredentialFallback?.(config)?.path?.trim();
    if (fallbackPath) {
      const before = new Set(targetIds);
      const added = addConfigPathTargets({
        path: fallbackPath,
        targetIds,
        targetPaths,
        allowedPaths,
      });
      for (const targetId of targetIds) {
        if (!before.has(targetId)) {
          fallbackTargetIds.add(targetId);
        }
      }
      if (added) {
        fallbackPaths.add(fallbackPath);
      }
    }
  }
  return {
    matchedProvider: providers.length > 0,
    targetIds: [...targetIds].toSorted(),
    targetPaths: [...targetPaths].toSorted(),
    allowedPaths: [...allowedPaths].toSorted(),
    fallbackTargetIds: [...fallbackTargetIds].toSorted(),
    fallbackPaths: [...fallbackPaths].toSorted(),
  };
}

function getCapabilityWebSearchAutoDetectTargets(config: OpenClawConfig): CommandSecretTargetScope {
  const baseTargetIds = getCapabilityWebSearchCommandSecretTargetIds();
  const targetIds = new Set(baseTargetIds);
  const fallbackTargetIds = new Set<string>();
  const fallbackPaths = new Set<string>();
  const providers = sortWebSearchProvidersForAutoDetect(
    resolvePluginWebSearchProviders({
      config,
      bundledAllowlistCompat: true,
    }),
  );
  for (const provider of providers) {
    if (hasConfiguredSearchCredential({ provider, config })) {
      break;
    }
    const fallback = provider.getConfiguredCredentialFallback?.(config);
    const fallbackPath = fallback?.path?.trim();
    if (!fallbackPath || !isConfiguredSecretCandidate(fallback?.value)) {
      continue;
    }
    for (const targetId of targetIdsForConfigPath(fallbackPath)) {
      targetIds.add(targetId);
      fallbackTargetIds.add(targetId);
    }
    fallbackPaths.add(fallbackPath);
    break;
  }
  if (fallbackTargetIds.size === 0) {
    return { targetIds };
  }
  const allowedPaths = mergeConfiguredAllowedPaths({
    config,
    baseTargetIds,
    concreteFallbackPaths: fallbackPaths,
  });
  const optionalActivePaths = discoverForcedActivePaths(config, fallbackTargetIds, allowedPaths);
  return {
    targetIds,
    ...(allowedPaths ? { allowedPaths } : {}),
    ...(optionalActivePaths ? { optionalActivePaths } : {}),
  };
}

function getCapabilityWebFetchAutoDetectTargets(config: OpenClawConfig): CommandSecretTargetScope {
  const baseTargetIds = getCapabilityWebFetchCommandSecretTargetIds();
  const targetIds = new Set(baseTargetIds);
  const fallbackTargetIds = new Set<string>();
  const fallbackPaths = new Set<string>();
  const providers = sortWebFetchProvidersForAutoDetect(
    resolvePluginWebFetchProviders({
      config,
      bundledAllowlistCompat: true,
    }),
  );
  for (const provider of providers) {
    if (hasConfiguredFetchCredential({ provider, config })) {
      break;
    }
    const fallback = provider.getConfiguredCredentialFallback?.(config);
    const fallbackPath = fallback?.path?.trim();
    if (!fallbackPath || !isConfiguredSecretCandidate(fallback?.value)) {
      continue;
    }
    for (const targetId of targetIdsForConfigPath(fallbackPath)) {
      targetIds.add(targetId);
      fallbackTargetIds.add(targetId);
    }
    fallbackPaths.add(fallbackPath);
    break;
  }
  if (fallbackTargetIds.size === 0) {
    return { targetIds };
  }
  const allowedPaths = mergeConfiguredAllowedPaths({
    config,
    baseTargetIds,
    concreteFallbackPaths: fallbackPaths,
  });
  const optionalActivePaths = discoverForcedActivePaths(config, fallbackTargetIds, allowedPaths);
  return {
    targetIds,
    ...(allowedPaths ? { allowedPaths } : {}),
    ...(optionalActivePaths ? { optionalActivePaths } : {}),
  };
}

function getAgentRuntimeBaseTargetIds(): string[] {
  cachedAgentRuntimeBaseTargetIds ??= [
    ...STATIC_AGENT_RUNTIME_BASE_TARGET_IDS,
    ...listSecretTargetRegistryEntries()
      .map((entry) => entry.id)
      .filter(isPluginWebCredentialTargetId)
      .toSorted(),
  ];
  return cachedAgentRuntimeBaseTargetIds;
}

function isScopedChannelSecretTargetEntry(params: {
  entry: {
    id: string;
    configFile?: string;
    pathPattern?: string;
    refPathPattern?: string;
  };
  pluginChannelId: string;
}): boolean {
  const channelId = normalizeOptionalString(params.pluginChannelId);
  if (!channelId) {
    return false;
  }
  const allowedPrefix = `channels.${channelId}.`;
  return (
    params.entry.id.startsWith(allowedPrefix) &&
    params.entry.configFile === "openclaw.json" &&
    typeof params.entry.pathPattern === "string" &&
    params.entry.pathPattern.startsWith(allowedPrefix) &&
    (params.entry.refPathPattern === undefined ||
      params.entry.refPathPattern.startsWith(allowedPrefix))
  );
}

function getConfiguredChannelSecretTargetIds(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const targetIds = new Set<string>();
  const channels = config.channels;
  if (channels && typeof channels === "object" && !Array.isArray(channels)) {
    for (const channelId of Object.keys(channels)) {
      if (channelId === "defaults") {
        continue;
      }
      const contract = loadChannelSecretContractApi({ channelId, config, env });
      for (const entry of contract?.secretTargetRegistryEntries ?? []) {
        if (isScopedChannelSecretTargetEntry({ entry, pluginChannelId: channelId })) {
          targetIds.add(entry.id);
        }
      }
    }
  }
  for (const plugin of listReadOnlyChannelPluginsForConfig(config, {
    env,
    includePersistedAuthState: false,
  })) {
    for (const entry of plugin.secrets?.secretTargetRegistryEntries ?? []) {
      if (isScopedChannelSecretTargetEntry({ entry, pluginChannelId: plugin.id })) {
        targetIds.add(entry.id);
      }
    }
  }
  return [...targetIds].toSorted((left, right) => left.localeCompare(right));
}

function buildCommandSecretTargets(): CommandSecretTargets {
  const channelTargetIds = getChannelSecretTargetIds();
  return {
    channels: channelTargetIds,
    agentRuntime: [...getAgentRuntimeBaseTargetIds(), ...channelTargetIds],
    status: [...STATIC_STATUS_TARGET_IDS, ...channelTargetIds],
    securityAudit: [...STATIC_SECURITY_AUDIT_TARGET_IDS, ...channelTargetIds],
  };
}

function getCommandSecretTargets(): CommandSecretTargets {
  cachedCommandSecretTargets ??= buildCommandSecretTargets();
  return cachedCommandSecretTargets;
}

function toTargetIdSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

function selectChannelTargetIds(channel?: string): Set<string> {
  const commandSecretTargets = getCommandSecretTargets();
  if (!channel) {
    return toTargetIdSet(commandSecretTargets.channels);
  }
  return toTargetIdSet(
    commandSecretTargets.channels.filter((id) => id.startsWith(`channels.${channel}.`)),
  );
}

function pathTargetsScopedChannelAccount(params: {
  pathSegments: readonly string[];
  channel: string;
  accountId: string;
}): boolean {
  const [root, channelId, accountRoot, accountId] = params.pathSegments;
  if (root !== "channels" || channelId !== params.channel) {
    return false;
  }
  if (accountRoot !== "accounts") {
    return true;
  }
  return accountId === params.accountId;
}

export function getScopedChannelsCommandSecretTargets(params: {
  config: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): {
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
} {
  const channel = normalizeOptionalString(params.channel);
  const targetIds = selectChannelTargetIds(channel);
  const normalizedAccountId = normalizeOptionalAccountId(params.accountId);
  if (!channel || !normalizedAccountId) {
    return { targetIds };
  }

  const allowedPaths = new Set<string>();
  for (const target of discoverConfigSecretTargetsByIds(params.config, targetIds)) {
    if (
      pathTargetsScopedChannelAccount({
        pathSegments: target.pathSegments,
        channel,
        accountId: normalizedAccountId,
      })
    ) {
      allowedPaths.add(target.path);
    }
  }
  return { targetIds, allowedPaths };
}

export function getQrRemoteCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(STATIC_QR_REMOTE_TARGET_IDS);
}

export function getChannelsCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(getCommandSecretTargets().channels);
}

export function getConfiguredChannelsCommandSecretTargetIds(
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Set<string> {
  return toTargetIdSet(getConfiguredChannelSecretTargetIds(config, env));
}

export function getModelsCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(STATIC_MODEL_TARGET_IDS);
}

export function getMemoryEmbeddingCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(STATIC_MEMORY_EMBEDDING_TARGET_IDS);
}

export function getTtsCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(STATIC_TTS_TARGET_IDS);
}

export function getAgentRuntimeCommandSecretTargetIds(params?: {
  includeChannelTargets?: boolean;
}): Set<string> {
  if (params?.includeChannelTargets !== true) {
    return toTargetIdSet(getAgentRuntimeBaseTargetIds());
  }
  return toTargetIdSet(getCommandSecretTargets().agentRuntime);
}

export function getCapabilityWebFetchCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(getCapabilityWebFetchTargetIds());
}

export function getCapabilityWebFetchCommandSecretTargets(
  config: OpenClawConfig,
  options?: {
    providerId?: string | null;
  },
): CommandSecretTargetScope {
  if (resolveFetchConfig(config)?.enabled === false) {
    return { targetIds: getCapabilityWebFetchCommandSecretTargetIds() };
  }
  const selectedProviderId = resolveSelectedWebFetchProviderId(config, options?.providerId);
  if (!selectedProviderId) {
    return getCapabilityWebFetchAutoDetectTargets(config);
  }
  const selectedTargets = getCapabilityWebFetchSelectedProviderTargetIds(
    config,
    selectedProviderId,
  );
  if (!selectedTargets.matchedProvider && !options?.providerId) {
    return getCapabilityWebFetchAutoDetectTargets(config);
  }
  const targetIds = toTargetIdSet(selectedTargets.targetIds);
  const allowedPaths =
    selectedTargets.allowedPaths.length > 0 ? new Set(selectedTargets.targetPaths) : undefined;
  const forcedActivePaths = discoverForcedActivePaths(
    config,
    toTargetIdSet(
      options?.providerId ? selectedTargets.targetIds : selectedTargets.fallbackTargetIds,
    ),
    allowedPaths,
  );
  return {
    targetIds,
    ...(allowedPaths ? { allowedPaths } : {}),
    ...(forcedActivePaths ? { forcedActivePaths } : {}),
  };
}

export function getCapabilityWebSearchCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(getCapabilityWebSearchTargetIds());
}

export function getCapabilityWebSearchCommandSecretTargets(
  config: OpenClawConfig,
  options?: {
    providerId?: string | null;
  },
): CommandSecretTargetScope {
  if (resolveSearchConfig(config)?.enabled === false) {
    return { targetIds: getCapabilityWebSearchCommandSecretTargetIds() };
  }
  const selectedProviderId = resolveSelectedWebSearchProviderId(config, options?.providerId);
  if (!selectedProviderId) {
    return getCapabilityWebSearchAutoDetectTargets(config);
  }
  const selectedTargets = getCapabilityWebSearchSelectedProviderTargetIds(
    config,
    selectedProviderId,
  );
  if (!selectedTargets.matchedProvider && !options?.providerId) {
    return getCapabilityWebSearchAutoDetectTargets(config);
  }
  const targetIds = toTargetIdSet(selectedTargets.targetIds);
  const allowedPaths =
    selectedTargets.allowedPaths.length > 0 ? new Set(selectedTargets.targetPaths) : undefined;
  const forcedActivePaths = discoverForcedActivePaths(
    config,
    toTargetIdSet(
      options?.providerId ? selectedTargets.targetIds : selectedTargets.fallbackTargetIds,
    ),
    allowedPaths,
  );
  return {
    targetIds,
    ...(allowedPaths ? { allowedPaths } : {}),
    ...(forcedActivePaths ? { forcedActivePaths } : {}),
  };
}

export function getStatusCommandSecretTargetIds(
  config?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Set<string> {
  const channelTargetIds = config
    ? getConfiguredChannelSecretTargetIds(config, env)
    : getChannelSecretTargetIds();
  return toTargetIdSet([...STATIC_STATUS_TARGET_IDS, ...channelTargetIds]);
}

export function getSecurityAuditCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet(getCommandSecretTargets().securityAudit);
}
