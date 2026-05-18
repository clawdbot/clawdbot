import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebFetchProviderEntry,
  WebFetchProviderToolDefinition,
} from "../plugins/types.js";
import {
  resolvePluginWebFetchProviders,
  resolveRuntimeWebFetchProviders,
} from "../plugins/web-fetch-providers.runtime.js";
import { sortWebFetchProvidersForAutoDetect } from "../plugins/web-fetch-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  resolveWebProviderDefinition,
} from "../web/provider-runtime-shared.js";

type WebFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

export type ResolveWebFetchDefinitionParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
};

export function resolveWebFetchEnabled(params: {
  fetch?: WebFetchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.fetch?.enabled === "boolean") {
    return params.fetch.enabled;
  }
  return true;
}

function resolveFetchConfig(config: OpenClawConfig | undefined): WebFetchConfig | undefined {
  return resolveWebProviderConfig(config, "fetch") as NonNullable<WebFetchConfig> | undefined;
}

function hasEntryCredential(
  provider: Pick<
    PluginWebFetchProviderEntry,
    | "envVars"
    | "getConfiguredCredentialFallback"
    | "getConfiguredCredentialValue"
    | "getCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  fetch: WebFetchConfig | undefined,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    toolConfig: fetch as Record<string, unknown> | undefined,
    resolveRawValue: ({ provider: currentProvider, config: currentConfig, toolConfig }) =>
      currentProvider.getConfiguredCredentialValue?.(currentConfig) ??
      currentProvider.getCredentialValue(toolConfig),
    resolveFallbackRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialFallback?.(currentConfig)?.value,
    resolveEnvValue: ({ provider: currentProvider }) =>
      readWebProviderEnvValue(currentProvider.envVars),
  });
}

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

export function listWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebFetchProviders({
    config: params?.config,
    bundledAllowlistCompat: true,
  });
}

export function listConfiguredWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebFetchProviders({
    config: params?.config,
    bundledAllowlistCompat: true,
  });
}

export function resolveWebFetchProviderId(params: {
  fetch?: WebFetchConfig;
  config?: OpenClawConfig;
  providers?: PluginWebFetchProviderEntry[];
}): string {
  const providers = sortWebFetchProvidersForAutoDetect(
    params.providers ??
      resolvePluginWebFetchProviders({
        config: params.config,
        bundledAllowlistCompat: true,
      }),
  );
  const raw =
    params.fetch && "provider" in params.fetch
      ? normalizeLowercaseStringOrEmpty(params.fetch.provider)
      : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  for (const provider of providers) {
    if (!providerRequiresCredential(provider)) {
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

export function resolveWebFetchDefinition(
  options?: ResolveWebFetchDefinitionParams,
): { provider: PluginWebFetchProviderEntry; definition: WebFetchProviderToolDefinition } | null {
  const fetch = resolveWebProviderConfig(options?.config, "fetch") as
    | NonNullable<WebFetchConfig>
    | undefined;
  const runtimeWebFetch = options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadata()?.fetch;
  const providers = sortWebFetchProvidersForAutoDetect(
    options?.sandboxed
      ? resolvePluginWebFetchProviders({
          config: options?.config,
          bundledAllowlistCompat: true,
          origin: "bundled",
        })
      : options?.preferRuntimeProviders
        ? resolveRuntimeWebFetchProviders({
            config: options?.config,
            bundledAllowlistCompat: true,
          })
        : resolvePluginWebFetchProviders({
            config: options?.config,
            bundledAllowlistCompat: true,
          }),
  );
  return resolveWebProviderDefinition({
    config: options?.config,
    toolConfig: fetch as Record<string, unknown> | undefined,
    runtimeMetadata: runtimeWebFetch,
    sandboxed: options?.sandboxed,
    providerId:
      options?.providerId ??
      resolveConfiguredWebFetchProviderId({
        fetch,
        providers,
      }),
    providers,
    resolveEnabled: ({ toolConfig, sandboxed }) =>
      resolveWebFetchEnabled({
        fetch: toolConfig as WebFetchConfig | undefined,
        sandboxed,
      }),
    resolveAutoProviderId: ({ config, toolConfig, providers }) =>
      resolveWebFetchProviderId({
        config,
        fetch: toolConfig as WebFetchConfig | undefined,
        providers,
      }),
    createTool: ({ provider, config, toolConfig, runtimeMetadata }) =>
      provider.createTool({
        config,
        fetchConfig: toolConfig,
        runtimeMetadata,
      }),
  });
}
