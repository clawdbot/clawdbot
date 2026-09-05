/** Runtime provider selection and tool construction for the `web_fetch` tool. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";
import type {
  PluginWebFetchProviderEntry,
  WebFetchProviderToolDefinition,
} from "../plugins/types.js";
import {
  resolvePluginWebFetchProviders,
  resolveRuntimeWebFetchProviders,
} from "../plugins/web-fetch-providers.runtime.js";
import { sortWebFetchProvidersForAutoDetect } from "../plugins/web-fetch-providers.shared.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
} from "../web/provider-runtime-shared.js";

// Runtime provider selection for the web_fetch tool. It resolves config,
// credentials, runtime metadata, and sandbox-safe bundled provider scopes.
type WebFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type ResolveWebFetchDefinitionParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
};
type WebFetchDefinitionResolution = {
  provider: PluginWebFetchProviderEntry;
  definition: WebFetchProviderToolDefinition;
} | null;
type WebFetchProviderCacheEntry = {
  cacheKey: string;
  configFingerprint: string;
  providers: PluginWebFetchProviderEntry[];
};

let webFetchProviderCache = new WeakMap<OpenClawConfig, WebFetchProviderCacheEntry>();

function resolveFetchConfig(config: OpenClawConfig | undefined): WebFetchConfig | undefined {
  return resolveWebProviderConfig(config, "fetch") as NonNullable<WebFetchConfig> | undefined;
}

function hasEntryCredential(
  provider: Pick<
    PluginWebFetchProviderEntry,
    | "envVars"
    | "getConfiguredCredentialFallback"
    | "getConfiguredCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  fetch: WebFetchConfig | undefined,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    toolConfig: fetch as Record<string, unknown> | undefined,
    resolveRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialValue?.(currentConfig),
    resolveFallbackRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialFallback?.(currentConfig)?.value,
    resolveEnvValue: ({ provider: currentProvider }) =>
      readWebProviderEnvValue(currentProvider.envVars),
  });
}

function hasAutoDetectCredential(
  provider: Pick<
    PluginWebFetchProviderEntry,
    | "envVars"
    | "getConfiguredCredentialFallback"
    | "getConfiguredCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  fetch: WebFetchConfig | undefined,
): boolean {
  return hasEntryCredential(
    {
      ...provider,
      requiresCredential: true,
    },
    config,
    fetch,
  );
}

/** Reports whether a web_fetch provider has usable credentials. */
export function isWebFetchProviderConfigured(params: {
  provider: Pick<
    PluginWebFetchProviderEntry,
    | "envVars"
    | "getConfiguredCredentialFallback"
    | "getConfiguredCredentialValue"
    | "getCredentialValue"
    | "requiresCredential"
  >;
  config?: OpenClawConfig;
}): boolean {
  return hasEntryCredential(params.provider, params.config, resolveFetchConfig(params.config));
}

/** Lists web_fetch providers available to runtime selection. */
export function listWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebFetchProviders({
    config: params?.config,
  });
}

/** Auto-detects a web_fetch provider after explicit selections have been resolved. */
function resolveAutoWebFetchProviderId(params: {
  fetch?: WebFetchConfig;
  config?: OpenClawConfig;
  providers: PluginWebFetchProviderEntry[];
}): string {
  const raw =
    params.fetch && "provider" in params.fetch
      ? normalizeLowercaseStringOrEmpty(params.fetch.provider)
      : "";

  for (const provider of params.providers) {
    if (!providerRequiresCredential(provider)) {
      if (!hasAutoDetectCredential(provider, params.config, params.fetch)) {
        continue;
      }
      logVerbose(
        `web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected keyless provider "${provider.id}"`,
      );
      return provider.id;
    }
    if (!hasEntryCredential(provider, params.config, params.fetch)) {
      continue;
    }
    logVerbose(
      `web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected "${provider.id}" from available API keys`,
    );
    return provider.id;
  }

  return "";
}

function resolveConfiguredWebFetchProviderId(params: {
  fetch?: WebFetchConfig;
  providers: PluginWebFetchProviderEntry[];
}): string | undefined {
  const raw =
    params.fetch && "provider" in params.fetch
      ? normalizeLowercaseStringOrEmpty(params.fetch.provider)
      : "";
  if (!raw) {
    return undefined;
  }
  return params.providers.find((provider) => provider.id === raw)?.id;
}

function resolveWebFetchProviderCacheKey(
  options: ResolveWebFetchDefinitionParams | undefined,
): string {
  return JSON.stringify([
    getActivePluginRegistryVersion(),
    options?.sandboxed === true,
    options?.preferRuntimeProviders === true,
  ]);
}

function resolveCachedWebFetchProviders(params: {
  cacheKey: string;
  config: OpenClawConfig;
  configFingerprint: string;
  load: () => PluginWebFetchProviderEntry[];
}): PluginWebFetchProviderEntry[] {
  const cached = webFetchProviderCache.get(params.config);
  if (
    cached?.cacheKey === params.cacheKey &&
    cached.configFingerprint === params.configFingerprint
  ) {
    return cached.providers;
  }
  const loaded = params.load();
  if (loaded.length > 0) {
    webFetchProviderCache.set(params.config, {
      cacheKey: params.cacheKey,
      configFingerprint: params.configFingerprint,
      providers: loaded,
    });
  }
  return loaded;
}

export function clearWebFetchRuntimeCachesForTest(): void {
  webFetchProviderCache = new WeakMap();
}

function resolveWebFetchProvidersForOptions(
  options?: ResolveWebFetchDefinitionParams,
): PluginWebFetchProviderEntry[] {
  const load = () =>
    sortWebFetchProvidersForAutoDetect(
      options?.sandboxed
        ? resolvePluginWebFetchProviders({
            config: options?.config,
            sandboxed: true,
          })
        : options?.preferRuntimeProviders
          ? resolveRuntimeWebFetchProviders({
              config: options?.config,
            })
          : resolvePluginWebFetchProviders({
              config: options?.config,
            }),
    );
  if (options?.config) {
    return resolveCachedWebFetchProviders({
      config: options.config,
      cacheKey: resolveWebFetchProviderCacheKey(options),
      configFingerprint: resolveRuntimeConfigCacheKey(options.config),
      load,
    });
  }
  return load();
}

/** Resolves the executable web_fetch provider tool definition. */
export function resolveWebFetchDefinition(
  options?: ResolveWebFetchDefinitionParams,
): WebFetchDefinitionResolution {
  const fetch = resolveFetchConfig(options?.config);
  if (fetch?.enabled === false) {
    return null;
  }
  const runtimeWebFetch =
    options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadataFromState()?.fetch;
  const providers = resolveWebFetchProvidersForOptions(options);
  if (providers.length === 0) {
    return null;
  }
  const providerId =
    options?.providerId ??
    resolveConfiguredWebFetchProviderId({ fetch, providers }) ??
    runtimeWebFetch?.selectedProvider ??
    resolveAutoWebFetchProviderId({ config: options?.config, fetch, providers });
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    return null;
  }
  const definition = provider.createTool({
    config: options?.config,
    fetchConfig: fetch as Record<string, unknown> | undefined,
    runtimeMetadata: runtimeWebFetch,
  });
  return definition ? { provider, definition } : null;
}
