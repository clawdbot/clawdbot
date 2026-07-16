// Web search runtime resolves configured search providers and executes searches.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
} from "../../packages/web-content-core/src/provider-runtime-shared.js";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { hasAuthProfileForProvider } from "../agents/tools/model-config.helpers.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry-contributions.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { executeWebSearchCandidates } from "./runtime-execution.js";
import type {
  ResolveWebSearchDefinitionParams,
  RunWebSearchParams,
  RunWebSearchResult,
  RuntimeWebSearchConfig as WebSearchConfig,
} from "./runtime-types.js";

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  return resolveWebProviderConfig(cfg, "search") as NonNullable<WebSearchConfig> | undefined;
}

function resolveWebSearchRuntimeConfig(params?: {
  config?: OpenClawConfig;
  preferInputConfig?: boolean;
}): OpenClawConfig | undefined {
  if (params?.preferInputConfig && params.config) {
    return params.config;
  }
  return selectApplicableRuntimeConfig({
    inputConfig: params?.config,
    runtimeConfig: getRuntimeConfigSnapshot(),
    runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
  });
}

/** Resolves whether web_search is enabled for the current config/sandbox. */
function resolveWebSearchEnabled(params: {
  search?: WebSearchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function hasEntryCredential(
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "authProviderId"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getConfiguredCredentialFallback"
    | "getCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  search: WebSearchConfig | undefined,
  agentDir?: string,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    toolConfig: search as Record<string, unknown> | undefined,
    resolveRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialValue?.(currentConfig),
    resolveFallbackRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialFallback?.(currentConfig)?.value,
    resolveEnvValue: ({ provider: currentProvider, configuredEnvVarId }) =>
      (configuredEnvVarId ? readWebProviderEnvValue([configuredEnvVarId]) : undefined) ??
      readWebProviderEnvValue(currentProvider.envVars),
    resolveProviderAuthValue: (providerId) =>
      hasAuthProfileForProvider({
        provider: providerId,
        agentDir: agentDir?.trim() || resolveDefaultAgentDir(config ?? {}),
      }),
  });
}

function hasImplicitProviderSelectionSignal(
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "authProviderId"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getConfiguredCredentialFallback"
    | "getCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  search: WebSearchConfig | undefined,
  agentDir?: string,
): boolean {
  if (!providerRequiresCredential(provider)) {
    return false;
  }
  return hasEntryCredential(provider, config, search, agentDir);
}

/** Reports whether a web_search provider has usable configured credentials. */
export function isWebSearchProviderConfigured(params: {
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "authProviderId"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getConfiguredCredentialFallback"
    | "getCredentialValue"
    | "requiresCredential"
  >;
  config?: OpenClawConfig;
}): boolean {
  const config = resolveWebSearchRuntimeConfig({ config: params.config });
  return hasEntryCredential(params.provider, config, resolveSearchConfig(config));
}

/** Lists runtime web_search providers after applying runtime config snapshots. */
export function listWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig({ config: params?.config });
  return resolveRuntimeWebSearchProviders({
    config,
  });
}

/** Lists plugin-configured web_search providers without runtime-only providers. */
export function listConfiguredWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig({ config: params?.config });
  return resolvePluginWebSearchProviders({
    config,
  });
}

/** Resolves configured or auto-detected web_search provider id. */
export function resolveWebSearchProviderId(params: {
  search?: WebSearchConfig;
  config?: OpenClawConfig;
  agentDir?: string;
  providers?: PluginWebSearchProviderEntry[];
}): string {
  const config = resolveWebSearchRuntimeConfig({ config: params.config });
  const search = params.search ?? resolveSearchConfig(config);
  const providers = sortWebSearchProvidersForAutoDetect(
    params.providers ??
      resolvePluginWebSearchProviders({
        config,
      }),
  );
  const raw =
    search && "provider" in search ? normalizeLowercaseStringOrEmpty(search.provider) : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  if (!raw) {
    for (const provider of providers) {
      if (!hasImplicitProviderSelectionSignal(provider, config, search, params.agentDir)) {
        continue;
      }
      logVerbose(
        `web_search: no provider configured, auto-detected "${provider.id}" from available credentials`,
      );
      return provider.id;
    }
    return "";
  }

  return "";
}

function resolveRuntimePreferredWebSearchProviderId(params: {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providers?: PluginWebSearchProviderEntry[];
  agentDir?: string;
}): string | undefined {
  const runtimeProviderId = normalizeOptionalLowercaseString(
    params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured,
  );
  if (!runtimeProviderId) {
    return undefined;
  }
  const configuredProviderId =
    params.search && "provider" in params.search
      ? normalizeOptionalLowercaseString(params.search.provider)
      : undefined;
  if (configuredProviderId) {
    const configuredProvider = params.providers?.find((entry) => entry.id === configuredProviderId);
    return configuredProvider?.id === runtimeProviderId ? runtimeProviderId : undefined;
  }
  if (params.runtimeWebSearch?.providerSource === "configured") {
    return runtimeProviderId;
  }
  const provider = params.providers?.find((entry) => entry.id === runtimeProviderId);
  return provider &&
    hasImplicitProviderSelectionSignal(provider, params.config, params.search, params.agentDir)
    ? provider.id
    : undefined;
}

function resolveExplicitWebSearchProviderId(params: {
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  includeRuntimeSelection?: boolean;
}): string | undefined {
  const callerProviderId = normalizeOptionalLowercaseString(params.providerId);
  if (callerProviderId) {
    return callerProviderId;
  }

  if (params.includeRuntimeSelection && params.runtimeWebSearch?.providerSource === "configured") {
    const runtimeProviderId = normalizeOptionalLowercaseString(
      params.runtimeWebSearch.selectedProvider ?? params.runtimeWebSearch.providerConfigured,
    );
    if (runtimeProviderId) {
      return runtimeProviderId;
    }
  }

  const configuredProviderId =
    params.search && "provider" in params.search
      ? normalizeOptionalLowercaseString(params.search.provider)
      : undefined;
  if (configuredProviderId) {
    return configuredProviderId;
  }
  return undefined;
}

function resolveExplicitWebSearchProviderPluginIds(params: {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  includeRuntimeSelection?: boolean;
}): readonly string[] | undefined {
  const providerId = resolveExplicitWebSearchProviderId(params);
  if (!providerId) {
    return undefined;
  }
  const ownerPluginId = resolveManifestContractOwnerPluginId({
    config: params.config,
    contract: "webSearchProviders",
    value: providerId,
  });
  return ownerPluginId ? [ownerPluginId] : undefined;
}

function resolveWebSearchProviderLoadScope(params: {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  includeRuntimeSelection?: boolean;
}): { onlyPluginIds?: readonly string[] } {
  const onlyPluginIds = resolveExplicitWebSearchProviderPluginIds(params);
  return onlyPluginIds ? { onlyPluginIds } : {};
}

type WebSearchRequestContext = {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
};

function resolveWebSearchRequestContext(
  options?: Pick<
    ResolveWebSearchDefinitionParams,
    "config" | "preferInputConfig" | "runtimeWebSearch"
  >,
): WebSearchRequestContext {
  const config = resolveWebSearchRuntimeConfig({
    config: options?.config,
    preferInputConfig: options?.preferInputConfig,
  });
  return {
    config,
    search: resolveSearchConfig(config),
    runtimeWebSearch: options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search,
  };
}

function loadSortedWebSearchProviders(
  params: WebSearchRequestContext & {
    providerId?: string;
    preferRuntimeProviders?: boolean;
  },
): PluginWebSearchProviderEntry[] {
  const loadScope = resolveWebSearchProviderLoadScope({
    config: params.config,
    search: params.search,
    runtimeWebSearch: params.runtimeWebSearch,
    providerId: params.providerId,
    includeRuntimeSelection: Boolean(params.preferRuntimeProviders),
  });
  return sortWebSearchProvidersForAutoDetect(
    params.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config: params.config,
          ...loadScope,
        })
      : resolvePluginWebSearchProviders({
          config: params.config,
          ...loadScope,
        }),
  );
}

function resolveWebSearchCandidates(
  options?: ResolveWebSearchDefinitionParams,
): PluginWebSearchProviderEntry[] {
  const { config, search, runtimeWebSearch } = resolveWebSearchRequestContext(options);
  if (!resolveWebSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return [];
  }

  const providers = loadSortedWebSearchProviders({
    config,
    search,
    runtimeWebSearch,
    providerId: options?.providerId,
    preferRuntimeProviders: options?.preferRuntimeProviders,
  }).filter(Boolean);
  if (providers.length === 0) {
    return [];
  }

  const preferredIds = uniqueStrings(
    [
      options?.providerId,
      resolveRuntimePreferredWebSearchProviderId({
        config,
        search,
        runtimeWebSearch,
        providers,
        agentDir: options?.agentDir,
      }),
      resolveWebSearchProviderId({ config, agentDir: options?.agentDir, search, providers }),
    ].filter((value): value is string => Boolean(value)),
  );

  const explicitProviderId = options?.providerId?.trim();
  if (explicitProviderId && !providers.some((entry) => entry.id === explicitProviderId)) {
    throw new Error(`Unknown web_search provider "${explicitProviderId}".`);
  }
  const explicitSelection = hasExplicitWebSearchSelection({
    search,
    runtimeWebSearch,
    providerId: options?.providerId,
    providers,
  });
  if (preferredIds.length === 0 && !explicitSelection) {
    return [];
  }
  const fallbackProviders = explicitSelection
    ? providers
    : providers.filter((provider) =>
        hasImplicitProviderSelectionSignal(provider, config, search, options?.agentDir),
      );

  const orderedProviders = [
    ...preferredIds
      .map((id) => providers.find((entry) => entry.id === id))
      .filter((entry): entry is PluginWebSearchProviderEntry => Boolean(entry)),
    ...fallbackProviders.filter((entry) => !preferredIds.includes(entry.id)),
  ];
  return orderedProviders;
}

function hasExplicitWebSearchSelection(params: {
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  providers?: PluginWebSearchProviderEntry[];
}): boolean {
  if (params.providerId?.trim()) {
    return true;
  }
  const availableProviderIds = new Set(
    (params.providers ?? []).map((provider) => normalizeLowercaseStringOrEmpty(provider.id)),
  );
  const configuredProviderId =
    params.search && "provider" in params.search && typeof params.search.provider === "string"
      ? normalizeLowercaseStringOrEmpty(params.search.provider)
      : "";
  if (configuredProviderId && availableProviderIds.has(configuredProviderId)) {
    return true;
  }
  const runtimeConfiguredId = normalizeOptionalLowercaseString(
    params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured,
  );
  if (
    params.runtimeWebSearch?.providerSource === "configured" &&
    runtimeConfiguredId &&
    availableProviderIds.has(runtimeConfiguredId)
  ) {
    return true;
  }
  return false;
}

/** Executes web_search with fallback when selection was not explicit. */
export async function runWebSearch(params: RunWebSearchParams): Promise<RunWebSearchResult> {
  const config = resolveWebSearchRuntimeConfig({
    config: params.config,
    preferInputConfig: params.preferInputConfig,
  });
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = params.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const candidates = resolveWebSearchCandidates({
    ...params,
    config,
    runtimeWebSearch,
    preferRuntimeProviders: params.preferRuntimeProviders ?? true,
  });
  if (candidates.length === 0) {
    throw new Error("web_search is disabled or no provider is available.");
  }
  const allowFallback = !hasExplicitWebSearchSelection({
    search,
    runtimeWebSearch,
    providerId: params.providerId,
    providers: candidates,
  });
  return await executeWebSearchCandidates({
    candidates,
    config,
    searchConfig: search as Record<string, unknown> | undefined,
    runtimeMetadata: runtimeWebSearch,
    agentDir: params.agentDir,
    args: params.args,
    signal: params.signal,
    allowFallback,
  });
}
