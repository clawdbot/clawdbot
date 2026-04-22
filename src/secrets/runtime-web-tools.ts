import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchCredentialResolutionSource,
  WebSearchCredentialResolutionSource,
} from "../plugins/types.js";
import { sortWebFetchProvidersForAutoDetect } from "../plugins/web-fetch-providers.shared.js";
import {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web-provider-public-artifacts.explicit.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { secretRefKey } from "./ref-contract.js";
import { resolveSecretRefValues } from "./resolve.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import {
  ensureObject,
  hasConfiguredSecretRef,
  isRecord,
  resolveRuntimeWebProviderSurface,
  resolveRuntimeWebProviderSelection,
  type SecretResolutionResult,
} from "./runtime-web-tools.shared.js";
import type {
  RuntimeWebDiagnostic,
  RuntimeWebDiagnosticCode,
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
  RuntimeWebToolsMetadata,
} from "./runtime-web-tools.types.js";

export type {
  RuntimeWebDiagnostic,
  RuntimeWebDiagnosticCode,
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
  RuntimeWebToolsMetadata,
};

const loadRuntimeWebToolsFallbackProviders = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-fallback.runtime.js"),
  ({ runtimeWebToolsFallbackProviders }) => runtimeWebToolsFallbackProviders,
);
const loadRuntimeWebToolsPublicArtifacts = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-public-artifacts.runtime.js"),
  (mod) => mod,
);
const loadRuntimeWebToolsManifest = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-manifest.runtime.js"),
  (mod) => mod,
);

type FetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type SecretResolutionSource =
  | WebSearchCredentialResolutionSource
  | WebFetchCredentialResolutionSource;

function hasPluginScopedWebToolConfig(
  config: OpenClawConfig,
  key: "webSearch" | "webFetch",
): boolean {
  const entries = config.plugins?.entries;
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
    return Boolean(pluginConfig?.[key]);
  });
}

function inferSingleBundledPluginScopedWebToolConfigOwner(
  config: OpenClawConfig,
  key: "webSearch" | "webFetch",
): string | undefined {
  const entries = config.plugins?.entries;
  if (!entries) {
    return undefined;
  }
  const matches: string[] = [];
  for (const [pluginId, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || entry.enabled === false) {
      continue;
    }
    const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
    if (!isRecord(pluginConfig?.[key])) {
      continue;
    }
    matches.push(pluginId);
    if (matches.length > 1) {
      return undefined;
    }
  }
  return matches[0];
}

function inferExactBundledPluginScopedWebToolConfigOwner(params: {
  config: OpenClawConfig;
  key: "webSearch" | "webFetch";
  pluginId: string;
}): string | undefined {
  const entry = params.config.plugins?.entries?.[params.pluginId];
  if (!isRecord(entry) || entry.enabled === false) {
    return undefined;
  }
  const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
  return isRecord(pluginConfig?.[params.key]) ? params.pluginId : undefined;
}

async function hasCustomWebSearchPluginRisk(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const plugins = params.config.plugins;
  if (!plugins) {
    return false;
  }
  if (Array.isArray(plugins.load?.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.installs && Object.keys(plugins.installs).length > 0) {
    return true;
  }

  const { resolveManifestContractPluginIds } = await loadRuntimeWebToolsManifest();
  const bundledPluginIds = new Set<string>(
    resolveManifestContractPluginIds({
      contract: "webSearchProviders",
      origin: "bundled",
      config: params.config,
      env: params.env,
    }),
  );
  const hasNonBundledPluginId = (pluginId: string) => !bundledPluginIds.has(pluginId.trim());
  if (Array.isArray(plugins.allow) && plugins.allow.some(hasNonBundledPluginId)) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.some(hasNonBundledPluginId)) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).some(hasNonBundledPluginId)) {
    return true;
  }

  return false;
}

function readNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  names: string[],
): { value?: string; envVar?: string } {
  for (const envVar of names) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return { value, envVar };
    }
  }
  return {};
}

function buildUnresolvedReason(params: {
  path: string;
  kind: "unresolved" | "non-string" | "empty";
  refLabel: string;
}): string {
  if (params.kind === "non-string") {
    return `${params.path} SecretRef resolved to a non-string value.`;
  }
  if (params.kind === "empty") {
    return `${params.path} SecretRef resolved to an empty value.`;
  }
  return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
}

async function resolveSecretInputWithEnvFallback(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  defaults: SecretDefaults | undefined;
  value: unknown;
  path: string;
  envVars: string[];
  restrictEnvRefsToEnvVars?: boolean;
}): Promise<SecretResolutionResult<SecretResolutionSource>> {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults: params.defaults,
  });

  if (!ref) {
    const configValue = normalizeSecretInput(params.value);
    if (configValue) {
      return {
        value: configValue,
        source: "config",
        secretRefConfigured: false,
        fallbackUsedAfterRefFailure: false,
      };
    }
    const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
    if (fallback.value) {
      return {
        value: fallback.value,
        source: "env",
        fallbackEnvVar: fallback.envVar,
        secretRefConfigured: false,
        fallbackUsedAfterRefFailure: false,
      };
    }
    return {
      source: "missing",
      secretRefConfigured: false,
      fallbackUsedAfterRefFailure: false,
    };
  }

  const refLabel = `${ref.source}:${ref.provider}:${ref.id}`;
  let resolvedFromRef: string | undefined;
  let unresolvedRefReason: string | undefined;

  if (
    params.restrictEnvRefsToEnvVars === true &&
    ref.source === "env" &&
    !params.envVars.includes(ref.id)
  ) {
    unresolvedRefReason = `${params.path} SecretRef env var "${ref.id}" is not allowed.`;
  } else {
    try {
      const resolved = await resolveSecretRefValues([ref], {
        config: params.sourceConfig,
        env: params.context.env,
        cache: params.context.cache,
      });
      const resolvedValue = resolved.get(secretRefKey(ref));
      if (typeof resolvedValue !== "string") {
        unresolvedRefReason = buildUnresolvedReason({
          path: params.path,
          kind: "non-string",
          refLabel,
        });
      } else {
        resolvedFromRef = normalizeSecretInput(resolvedValue);
        if (!resolvedFromRef) {
          unresolvedRefReason = buildUnresolvedReason({
            path: params.path,
            kind: "empty",
            refLabel,
          });
        }
      }
    } catch {
      unresolvedRefReason = buildUnresolvedReason({
        path: params.path,
        kind: "unresolved",
        refLabel,
      });
    }
  }

  if (resolvedFromRef) {
    return {
      value: resolvedFromRef,
      source: "secretRef",
      secretRefConfigured: true,
      fallbackUsedAfterRefFailure: false,
    };
  }

  const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
  if (fallback.value) {
    return {
      value: fallback.value,
      source: "env",
      fallbackEnvVar: fallback.envVar,
      unresolvedRefReason,
      secretRefConfigured: true,
      fallbackUsedAfterRefFailure: true,
    };
  }

  return {
    source: "missing",
    unresolvedRefReason,
    secretRefConfigured: true,
    fallbackUsedAfterRefFailure: false,
  };
}

function setResolvedWebSearchApiKey(params: {
  resolvedConfig: OpenClawConfig;
  provider: PluginWebSearchProviderEntry;
  value: string;
}): void {
  if (params.provider.setConfiguredCredentialValue) {
    params.provider.setConfiguredCredentialValue(params.resolvedConfig, params.value);
    return;
  }
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const search = ensureObject(web, "search");
  params.provider.setCredentialValue(search, params.value);
}

async function resolveBundledWebSearchProviders(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  configuredBundledPluginId?: string;
  onlyPluginIds?: readonly string[];
  hasCustomWebSearchPluginRisk: boolean;
}): Promise<PluginWebSearchProviderEntry[]> {
  const env = { ...process.env, ...params.context.env };
  const onlyPluginIds =
    params.configuredBundledPluginId !== undefined
      ? [params.configuredBundledPluginId]
      : params.onlyPluginIds && params.onlyPluginIds.length > 0
        ? [...new Set(params.onlyPluginIds)].toSorted((left, right) => left.localeCompare(right))
        : undefined;
  if (onlyPluginIds && onlyPluginIds.length > 0) {
    const bundled = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({ onlyPluginIds });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebSearchProviders({
      config: params.sourceConfig,
      env,
      bundledAllowlistCompat: true,
      onlyPluginIds,
      origin: "bundled",
    });
  }
  if (!params.hasCustomWebSearchPluginRisk) {
    const { resolveBundledWebSearchProvidersFromPublicArtifacts } =
      await loadRuntimeWebToolsPublicArtifacts();
    const bundled = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: params.sourceConfig,
      env,
      bundledAllowlistCompat: true,
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebSearchProviders({
      config: params.sourceConfig,
      env,
      bundledAllowlistCompat: true,
      origin: "bundled",
    });
  }
  const { resolvePluginWebSearchProviders } = await loadRuntimeWebToolsFallbackProviders();
  return resolvePluginWebSearchProviders({
    config: params.sourceConfig,
    env,
    bundledAllowlistCompat: true,
  });
}

async function resolveBundledWebFetchProviders(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  configuredBundledPluginId?: string;
}): Promise<PluginWebFetchProviderEntry[]> {
  const env = { ...process.env, ...params.context.env };
  if (params.configuredBundledPluginId) {
    const bundled = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({
      onlyPluginIds: [params.configuredBundledPluginId],
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebFetchProviders } = await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebFetchProviders({
      config: params.sourceConfig,
      env,
      bundledAllowlistCompat: true,
      onlyPluginIds: [params.configuredBundledPluginId],
      origin: "bundled",
    });
  }
  const { resolveBundledWebFetchProvidersFromPublicArtifacts } =
    await loadRuntimeWebToolsPublicArtifacts();
  const bundled = resolveBundledWebFetchProvidersFromPublicArtifacts({
    config: params.sourceConfig,
    env,
    bundledAllowlistCompat: true,
  });
  if (bundled && bundled.length > 0) {
    return bundled;
  }
  const { resolvePluginWebFetchProviders } = await loadRuntimeWebToolsFallbackProviders();
  return resolvePluginWebFetchProviders({
    config: params.sourceConfig,
    env,
    bundledAllowlistCompat: true,
    origin: "bundled",
  });
}

function readConfiguredProviderCredential(params: {
  provider: PluginWebSearchProviderEntry;
  config: OpenClawConfig;
  search: Record<string, unknown> | undefined;
}): unknown {
  return params.provider.getConfiguredCredentialValue?.(params.config);
}

function inactivePathsForProvider(provider: PluginWebSearchProviderEntry): string[] {
  if (provider.requiresCredential === false) {
    return [];
  }
  return provider.inactiveSecretPaths?.length
    ? provider.inactiveSecretPaths
    : [provider.credentialPath];
}

function setResolvedWebFetchApiKey(params: {
  resolvedConfig: OpenClawConfig;
  provider: PluginWebFetchProviderEntry;
  value: string;
}): void {
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const fetch = ensureObject(web, "fetch");
  if (params.provider.setConfiguredCredentialValue) {
    params.provider.setConfiguredCredentialValue(params.resolvedConfig, params.value);
    return;
  }
  params.provider.setCredentialValue(fetch, params.value);
}

function readConfiguredFetchProviderCredential(params: {
  provider: PluginWebFetchProviderEntry;
  config: OpenClawConfig;
  fetch: Record<string, unknown> | undefined;
}): unknown {
  const configuredValue = params.provider.getConfiguredCredentialValue?.(params.config);
  return configuredValue ?? params.provider.getCredentialValue(params.fetch);
}

function inactivePathsForFetchProvider(provider: PluginWebFetchProviderEntry): string[] {
  if (provider.requiresCredential === false) {
    return [];
  }
  return provider.inactiveSecretPaths?.length
    ? provider.inactiveSecretPaths
    : [provider.credentialPath];
}

export async function resolveRuntimeWebTools(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  context: ResolverContext;
}): Promise<RuntimeWebToolsMetadata> {
  const defaults = params.sourceConfig.secrets?.defaults;
  const diagnostics: RuntimeWebDiagnostic[] = [];
  const env = { ...process.env, ...params.context.env };

  const sourceTools = isRecord(params.sourceConfig.tools) ? params.sourceConfig.tools : undefined;
  const sourceWeb = isRecord(sourceTools?.web) ? sourceTools.web : undefined;
  const resolvedTools = isRecord(params.resolvedConfig.tools)
    ? params.resolvedConfig.tools
    : undefined;
  const resolvedWeb = isRecord(resolvedTools?.web) ? resolvedTools.web : undefined;
  let hasCustomWebSearchRisk: Promise<boolean> | undefined;
  const getHasCustomWebSearchRisk = (): Promise<boolean> => {
    hasCustomWebSearchRisk ??= hasCustomWebSearchPluginRisk({
      config: params.sourceConfig,
      env,
    });
    return hasCustomWebSearchRisk;
  };
  const legacyXSearchSource = isRecord(sourceWeb?.x_search) ? sourceWeb.x_search : undefined;
  const legacyXSearchResolved = isRecord(resolvedWeb?.x_search) ? resolvedWeb.x_search : undefined;

  // Doctor owns the migration, but runtime still needs to resolve the legacy SecretRef surface
  // so existing configs do not silently stop working before users repair them.
  if (
    legacyXSearchSource &&
    legacyXSearchResolved &&
    Object.prototype.hasOwnProperty.call(legacyXSearchSource, "apiKey")
  ) {
    const legacyXSearchSourceRecord = legacyXSearchSource as Record<string, unknown>;
    const legacyXSearchResolvedRecord = legacyXSearchResolved as Record<string, unknown>;
    const resolution = await resolveSecretInputWithEnvFallback({
      sourceConfig: params.sourceConfig,
      context: params.context,
      defaults,
      value: legacyXSearchSourceRecord.apiKey,
      path: "tools.web.x_search.apiKey",
      envVars: ["XAI_API_KEY"],
    });
    if (resolution.value) {
      legacyXSearchResolvedRecord.apiKey = resolution.value;
    }
  }

  const hasPluginWebSearchConfig = hasPluginScopedWebToolConfig(params.sourceConfig, "webSearch");
  const hasPluginWebFetchConfig = hasPluginScopedWebToolConfig(params.sourceConfig, "webFetch");
  if (!sourceWeb && !hasPluginWebSearchConfig && !hasPluginWebFetchConfig) {
    return {
      search: {
        providerSource: "none",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics,
    };
  }
  const search = isRecord(sourceWeb?.search) ? sourceWeb.search : undefined;
  const fetch = isRecord(sourceWeb?.fetch) ? (sourceWeb.fetch as FetchConfig) : undefined;
  if (!search && !fetch && !hasPluginWebSearchConfig && !hasPluginWebFetchConfig) {
    return {
      search: {
        providerSource: "none",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics,
    };
  }
  const rawProvider = normalizeLowercaseStringOrEmpty(search?.provider);
  let configuredBundledWebSearchPluginIdHint: string | undefined;
  if (hasPluginWebSearchConfig && !(await getHasCustomWebSearchRisk())) {
    if (rawProvider) {
      configuredBundledWebSearchPluginIdHint = inferExactBundledPluginScopedWebToolConfigOwner({
        config: params.sourceConfig,
        key: "webSearch",
        pluginId: rawProvider,
      });
    }
    configuredBundledWebSearchPluginIdHint ??= inferSingleBundledPluginScopedWebToolConfigOwner(
      params.sourceConfig,
      "webSearch",
    );
  }
  const searchMetadata: RuntimeWebSearchMetadata = {
    providerSource: "none",
    diagnostics: [],
  };
  if (search || hasPluginWebSearchConfig) {
    const searchSurface = await resolveRuntimeWebProviderSurface({
      contract: "webSearchProviders",
      rawProvider,
      providerPath: "tools.web.search.provider",
      toolConfig: search,
      diagnostics,
      metadataDiagnostics: searchMetadata.diagnostics,
      invalidAutoDetectCode: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
      sourceConfig: params.sourceConfig,
      context: params.context,
      configuredBundledPluginIdHint: configuredBundledWebSearchPluginIdHint,
      resolveProviders: async ({ configuredBundledPluginId }) =>
        resolveBundledWebSearchProviders({
          sourceConfig: params.sourceConfig,
          context: params.context,
          configuredBundledPluginId,
          hasCustomWebSearchPluginRisk: await getHasCustomWebSearchRisk(),
        }),
      sortProviders: sortWebSearchProvidersForAutoDetect,
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredProviderCredential({
          provider,
          config,
          search: toolConfig,
        }),
      ignoreKeylessProvidersForConfiguredSurface: true,
      emptyProvidersWhenSurfaceMissing: true,
      normalizeConfiguredProviderAgainstActiveProviders: true,
    });

    await resolveRuntimeWebProviderSelection({
      scopePath: "tools.web.search",
      toolConfig: search,
      enabled: searchSurface.enabled,
      providers: searchSurface.providers,
      configuredProvider: searchSurface.configuredProvider,
      metadata: searchMetadata,
      diagnostics,
      sourceConfig: params.sourceConfig,
      resolvedConfig: params.resolvedConfig,
      context: params.context,
      defaults,
      deferKeylessFallback: true,
      fallbackUsedCode: "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED",
      noFallbackCode: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
      autoDetectSelectedCode: "WEB_SEARCH_AUTODETECT_SELECTED",
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredProviderCredential({
          provider,
          config,
          search: toolConfig,
        }),
      resolveSecretInput: ({ value, path, envVars }) =>
        resolveSecretInputWithEnvFallback({
          sourceConfig: params.sourceConfig,
          context: params.context,
          defaults,
          value,
          path,
          envVars,
        }),
      setResolvedCredential: ({ resolvedConfig, provider, value }) =>
        setResolvedWebSearchApiKey({
          resolvedConfig,
          provider,
          value,
        }),
      inactivePathsForProvider,
      hasConfiguredSecretRef,
      mergeRuntimeMetadata: async ({ provider, metadata, toolConfig, selectedResolution }) => {
        if (!provider.resolveRuntimeMetadata) {
          return;
        }
        Object.assign(
          metadata,
          await provider.resolveRuntimeMetadata({
            config: params.sourceConfig,
            searchConfig: toolConfig,
            runtimeMetadata: metadata,
            resolvedCredential: selectedResolution
              ? {
                  value: selectedResolution.value,
                  source: selectedResolution.source,
                  fallbackEnvVar: selectedResolution.fallbackEnvVar,
                }
              : undefined,
          }),
        );
      },
    });
  }

  const rawFetchProvider = normalizeLowercaseStringOrEmpty(fetch?.provider);
  const fetchMetadata: RuntimeWebFetchMetadata = {
    providerSource: "none",
    diagnostics: [],
  };
  if (fetch || hasPluginWebFetchConfig) {
    const fetchSurface = await resolveRuntimeWebProviderSurface({
      contract: "webFetchProviders",
      rawProvider: rawFetchProvider,
      providerPath: "tools.web.fetch.provider",
      toolConfig: fetch,
      diagnostics,
      metadataDiagnostics: fetchMetadata.diagnostics,
      invalidAutoDetectCode: "WEB_FETCH_PROVIDER_INVALID_AUTODETECT",
      sourceConfig: params.sourceConfig,
      context: params.context,
      resolveProviders: ({ configuredBundledPluginId }) =>
        resolveBundledWebFetchProviders({
          sourceConfig: params.sourceConfig,
          context: params.context,
          configuredBundledPluginId,
        }),
      sortProviders: sortWebFetchProvidersForAutoDetect,
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredFetchProviderCredential({
          provider,
          config,
          fetch: toolConfig,
        }),
    });

    await resolveRuntimeWebProviderSelection({
      scopePath: "tools.web.fetch",
      toolConfig: fetch,
      enabled: fetchSurface.enabled,
      providers: fetchSurface.providers,
      configuredProvider: fetchSurface.configuredProvider,
      metadata: fetchMetadata,
      diagnostics,
      sourceConfig: params.sourceConfig,
      resolvedConfig: params.resolvedConfig,
      context: params.context,
      defaults,
      deferKeylessFallback: false,
      fallbackUsedCode: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED",
      noFallbackCode: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK",
      autoDetectSelectedCode: "WEB_FETCH_AUTODETECT_SELECTED",
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredFetchProviderCredential({
          provider,
          config,
          fetch: toolConfig,
        }),
      resolveSecretInput: ({ value, path, envVars }) =>
        resolveSecretInputWithEnvFallback({
          sourceConfig: params.sourceConfig,
          context: params.context,
          defaults,
          value,
          path,
          envVars,
          restrictEnvRefsToEnvVars: true,
        }),
      setResolvedCredential: ({ resolvedConfig, provider, value }) =>
        setResolvedWebFetchApiKey({
          resolvedConfig,
          provider,
          value,
        }),
      inactivePathsForProvider: inactivePathsForFetchProvider,
      hasConfiguredSecretRef,
      mergeRuntimeMetadata: async ({ provider, metadata, toolConfig, selectedResolution }) => {
        if (!provider.resolveRuntimeMetadata) {
          return;
        }
        Object.assign(
          metadata,
          await provider.resolveRuntimeMetadata({
            config: params.sourceConfig,
            fetchConfig: toolConfig,
            runtimeMetadata: metadata,
            resolvedCredential: selectedResolution
              ? {
                  value: selectedResolution.value,
                  source: selectedResolution.source,
                  fallbackEnvVar: selectedResolution.fallbackEnvVar,
                }
              : undefined,
          }),
        );
      },
    });
  }

  return {
    search: searchMetadata,
    fetch: fetchMetadata,
    diagnostics,
  };
}
