import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry.js";
import { normalizeOptionalAccountId } from "../routing/session-key.js";
import { loadChannelSecretContractApi } from "../secrets/channel-contract-api.js";
import {
  discoverConfigSecretTargetsByIds,
  listSecretTargetRegistryEntries,
} from "../secrets/target-registry.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

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
const STATIC_WEB_SEARCH_TARGET_IDS = ["tools.web.search.apiKey"] as const;
const STATIC_WEB_FETCH_TARGET_IDS = ["tools.web.fetch.firecrawl.apiKey"] as const;
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

type CommandSecretTargetSelection = {
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
};

let cachedCommandSecretTargets: CommandSecretTargets | undefined;
let cachedAgentRuntimeBaseTargetIds: string[] | undefined;
let cachedChannelSecretTargetIds: string[] | undefined;

function getChannelSecretTargetIds(): string[] {
  cachedChannelSecretTargetIds ??= idsByPrefix(["channels."]);
  return cachedChannelSecretTargetIds;
}

function isPluginWebCredentialTargetId(id: string, configPathFilter?: string): boolean {
  const segments = id.split(".");
  if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") {
    return false;
  }
  const configPath = segments.slice(4).join(".");
  if (configPathFilter) {
    return configPath === configPathFilter;
  }
  return configPath === "webSearch.apiKey" || configPath === "webFetch.apiKey";
}

function getPluginWebCredentialTargetIds(configPath: "webSearch.apiKey" | "webFetch.apiKey") {
  return listSecretTargetRegistryEntries()
    .map((entry) => entry.id)
    .filter((id) => isPluginWebCredentialTargetId(id, configPath))
    .toSorted();
}

function pluginIdFromWebCredentialPath(
  path: string,
  configPath: "webSearch.apiKey" | "webFetch.apiKey",
): string | undefined {
  const match = /^plugins\.entries\.([^.]+)\.config\.(webSearch|webFetch)\.apiKey$/.exec(path);
  if (!match) {
    return undefined;
  }
  return match[2] === configPath.split(".")[0] ? match[1] : undefined;
}

function getAgentRuntimeBaseTargetIds(): string[] {
  cachedAgentRuntimeBaseTargetIds ??= [
    ...STATIC_AGENT_RUNTIME_BASE_TARGET_IDS,
    ...listSecretTargetRegistryEntries()
      .map((entry) => entry.id)
      .filter((id) => isPluginWebCredentialTargetId(id))
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

function mergeTargetIdSets(...sets: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  const merged = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      merged.add(value);
    }
  }
  return merged;
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

export function getWebSearchCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet([
    ...STATIC_WEB_SEARCH_TARGET_IDS,
    ...getPluginWebCredentialTargetIds("webSearch.apiKey"),
  ]);
}

export function getWebFetchCommandSecretTargetIds(): Set<string> {
  return toTargetIdSet([
    ...STATIC_WEB_FETCH_TARGET_IDS,
    ...getPluginWebCredentialTargetIds("webFetch.apiKey"),
  ]);
}

function getConfiguredWebProviderId(
  config: OpenClawConfig,
  kind: "search" | "fetch",
): string | undefined {
  const webConfig = config.tools?.web?.[kind];
  return normalizeOptionalLowercaseString(
    webConfig && typeof webConfig === "object" ? webConfig.provider : undefined,
  );
}

function configuredTargetPaths(config: OpenClawConfig, targetIds: Set<string>): Set<string> {
  return new Set(discoverConfigSecretTargetsByIds(config, targetIds).map((target) => target.path));
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

function resolveSelectedWebProviderPluginId(params: {
  config: OpenClawConfig;
  providerId: string | undefined;
  contract: "webSearchProviders" | "webFetchProviders";
}): string | undefined {
  if (!params.providerId) {
    return undefined;
  }
  return (
    resolveManifestContractOwnerPluginId({
      config: params.config,
      contract: params.contract,
      value: params.providerId,
    }) ?? params.providerId
  );
}

function pathForPluginCredential(
  paths: ReadonlySet<string>,
  pluginId: string | undefined,
  configPath: "webSearch.apiKey" | "webFetch.apiKey",
): string | undefined {
  if (!pluginId) {
    return undefined;
  }
  for (const path of paths) {
    if (pluginIdFromWebCredentialPath(path, configPath) === pluginId) {
      return path;
    }
  }
  return undefined;
}

export function getWebSearchCommandSecretTargets(params: {
  config: OpenClawConfig;
  provider?: string | null;
}): CommandSecretTargetSelection {
  const webSearchTargetIds = getWebSearchCommandSecretTargetIds();
  const targetIds = new Set(webSearchTargetIds);
  const providerId =
    normalizeOptionalLowercaseString(params.provider) ??
    getConfiguredWebProviderId(params.config, "search");
  const webSearchPaths = configuredTargetPaths(params.config, webSearchTargetIds);
  if (!providerId) {
    return { targetIds, allowedPaths: webSearchPaths };
  }

  const allowedPaths = new Set<string>();
  const selectedPluginId = resolveSelectedWebProviderPluginId({
    config: params.config,
    providerId,
    contract: "webSearchProviders",
  });
  const pluginCredentialPath = pathForPluginCredential(
    webSearchPaths,
    selectedPluginId,
    "webSearch.apiKey",
  );
  if (pluginCredentialPath) {
    allowedPaths.add(pluginCredentialPath);
    return { targetIds, allowedPaths };
  }

  const fallbackPath = modelProviderCredentialFallbackPathForWebSearchProvider(providerId);
  if (fallbackPath) {
    const modelPaths = configuredTargetPaths(params.config, getModelsCommandSecretTargetIds());
    if (modelPaths.has(fallbackPath)) {
      targetIds.add("models.providers.*.apiKey");
      allowedPaths.add(fallbackPath);
      return { targetIds, allowedPaths };
    }
  }

  if (webSearchPaths.has("tools.web.search.apiKey")) {
    allowedPaths.add("tools.web.search.apiKey");
  }
  return { targetIds, allowedPaths };
}

export function getWebFetchCommandSecretTargets(params: {
  config: OpenClawConfig;
  provider?: string | null;
}): CommandSecretTargetSelection {
  const webFetchTargetIds = getWebFetchCommandSecretTargetIds();
  const webSearchTargetIds = getWebSearchCommandSecretTargetIds();
  const webFetchPaths = configuredTargetPaths(params.config, webFetchTargetIds);
  const webSearchPaths = configuredTargetPaths(params.config, webSearchTargetIds);
  const providerId =
    normalizeOptionalLowercaseString(params.provider) ??
    getConfiguredWebProviderId(params.config, "fetch");
  const selectedPluginId = resolveSelectedWebProviderPluginId({
    config: params.config,
    providerId,
    contract: "webFetchProviders",
  });
  const webFetchPluginIds = new Set(
    [...getPluginWebCredentialTargetIds("webFetch.apiKey")]
      .map((id) => pluginIdFromWebCredentialPath(id, "webFetch.apiKey"))
      .filter((id): id is string => Boolean(id)),
  );
  const candidatePluginIds = new Set<string>();
  if (selectedPluginId) {
    candidatePluginIds.add(selectedPluginId);
  }
  for (const path of webFetchPaths) {
    const pluginId = pluginIdFromWebCredentialPath(path, "webFetch.apiKey");
    if (!selectedPluginId && pluginId) {
      candidatePluginIds.add(pluginId);
    }
  }
  for (const path of webSearchPaths) {
    const pluginId = pluginIdFromWebCredentialPath(path, "webSearch.apiKey");
    if (!selectedPluginId && pluginId && webFetchPluginIds.has(pluginId)) {
      candidatePluginIds.add(pluginId);
    }
  }

  const allowedPaths = new Set<string>();
  const pluginsWithFetchCredential = new Set<string>();
  let hasWebSearchFallbackPath = false;
  for (const path of webFetchPaths) {
    const pluginId = pluginIdFromWebCredentialPath(path, "webFetch.apiKey");
    if (!selectedPluginId || (pluginId && candidatePluginIds.has(pluginId))) {
      allowedPaths.add(path);
      if (pluginId) {
        pluginsWithFetchCredential.add(pluginId);
      }
    }
  }
  if (
    webFetchPaths.has("tools.web.fetch.firecrawl.apiKey") &&
    (!selectedPluginId || selectedPluginId === "firecrawl" || providerId === "firecrawl")
  ) {
    allowedPaths.add("tools.web.fetch.firecrawl.apiKey");
  }
  for (const path of webSearchPaths) {
    const pluginId = pluginIdFromWebCredentialPath(path, "webSearch.apiKey");
    if (pluginId && candidatePluginIds.has(pluginId) && !pluginsWithFetchCredential.has(pluginId)) {
      allowedPaths.add(path);
      hasWebSearchFallbackPath = true;
    }
  }

  const targetIds = hasWebSearchFallbackPath
    ? mergeTargetIdSets(webFetchTargetIds, webSearchTargetIds)
    : new Set(webFetchTargetIds);
  return { targetIds, allowedPaths };
}

export function getAgentRuntimeCommandSecretTargetIds(params?: {
  includeChannelTargets?: boolean;
}): Set<string> {
  if (params?.includeChannelTargets !== true) {
    return toTargetIdSet(getAgentRuntimeBaseTargetIds());
  }
  return toTargetIdSet(getCommandSecretTargets().agentRuntime);
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
