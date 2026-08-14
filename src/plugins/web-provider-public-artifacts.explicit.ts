// Extracts explicit public artifacts from web provider plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "./public-surface-loader.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

const WEB_SEARCH_ARTIFACT_CANDIDATES = [
  "web-search-contract-api.js",
  "web-search-provider.js",
  "web-search.js",
] as const;
const WEB_FETCH_ARTIFACT_CANDIDATES = [
  "web-fetch-contract-api.js",
  "web-fetch-provider.js",
  "web-fetch.js",
] as const;
const WEB_FETCH_RUNTIME_ARTIFACT_CANDIDATES = ["web-fetch-provider.js", "web-fetch.js"] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isWebProviderPlugin(
  value: unknown,
): value is WebSearchProviderPlugin | WebFetchProviderPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.hint === "string" &&
    isStringArray(value.envVars) &&
    typeof value.placeholder === "string" &&
    typeof value.signupUrl === "string" &&
    typeof value.credentialPath === "string" &&
    typeof value.getCredentialValue === "function" &&
    typeof value.setCredentialValue === "function" &&
    typeof value.createTool === "function"
  );
}

function collectProviderFactories<TProvider>(params: {
  mod: Record<string, unknown>;
  suffix: string;
  isProvider: (value: unknown) => value is TProvider;
}): { providers: TProvider[]; errors: unknown[] } {
  const providers: TProvider[] = [];
  const errors: unknown[] = [];
  for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith(params.suffix)
    ) {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = exported();
    } catch (error) {
      errors.push(error);
      continue;
    }
    if (params.isProvider(candidate)) {
      providers.push(candidate);
    }
  }
  return { providers, errors };
}

function unableToInitializeProviderError(params: {
  pluginId: string;
  errors: readonly unknown[];
}): Error {
  return new Error(`Unable to initialize web providers for plugin ${params.pluginId}`, {
    cause: params.errors.length === 1 ? params.errors[0] : new AggregateError(params.errors),
  });
}

function loadBundledProviderEntriesFromDir<TProvider extends object>(params: {
  dirName: string;
  pluginId: string;
  artifactCandidates: readonly string[];
  suffix: string;
  isProvider: (value: unknown) => value is TProvider;
}): Array<TProvider & { pluginId: string }> | null {
  const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<Record<string, unknown>>({
    dirName: params.dirName,
    artifactCandidates: params.artifactCandidates,
  });
  if (!mod) {
    return null;
  }
  const { providers, errors } = collectProviderFactories({
    mod,
    suffix: params.suffix,
    isProvider: params.isProvider,
  });
  if (providers.length === 0) {
    if (errors.length > 0) {
      throw unableToInitializeProviderError({
        pluginId: params.pluginId,
        errors,
      });
    }
    return null;
  }
  return providers.map((provider) => Object.assign({}, provider, { pluginId: params.pluginId }));
}

function resolveBundledExplicitProviders<TProvider>(params: {
  onlyPluginIds: readonly string[];
  loadProviders: (pluginId: string) => TProvider[] | null;
}): TProvider[] | null {
  const providers: TProvider[] = [];
  // Sorted plugin IDs plus each module's sorted factories preserve stable
  // plugin and factory ordering across all three explicit resolution paths.
  for (const pluginId of sortUniqueStrings(params.onlyPluginIds)) {
    const loadedProviders = params.loadProviders(pluginId);
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function loadBundledWebSearchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebSearchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebSearchProviderPlugin>({
    ...params,
    artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
    suffix: "WebSearchProvider",
    isProvider: (value): value is WebSearchProviderPlugin => isWebProviderPlugin(value),
  });
}

export function loadBundledWebFetchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebFetchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebFetchProviderPlugin>({
    ...params,
    artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
    suffix: "WebFetchProvider",
    isProvider: (value): value is WebFetchProviderPlugin => isWebProviderPlugin(value),
  });
}

function loadBundledRuntimeWebFetchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebFetchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebFetchProviderPlugin>({
    ...params,
    artifactCandidates: WEB_FETCH_RUNTIME_ARTIFACT_CANDIDATES,
    suffix: "WebFetchProvider",
    isProvider: (value): value is WebFetchProviderPlugin => isWebProviderPlugin(value),
  });
}

export function resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null {
  return resolveBundledExplicitProviders({
    ...params,
    loadProviders: (pluginId) =>
      loadBundledWebSearchProviderEntriesFromDir({ dirName: pluginId, pluginId }),
  });
}

export function resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebFetchProviderEntry[] | null {
  return resolveBundledExplicitProviders({
    ...params,
    loadProviders: (pluginId) =>
      loadBundledWebFetchProviderEntriesFromDir({ dirName: pluginId, pluginId }),
  });
}

export function resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebFetchProviderEntry[] | null {
  return resolveBundledExplicitProviders({
    ...params,
    loadProviders: (pluginId) =>
      loadBundledRuntimeWebFetchProviderEntriesFromDir({ dirName: pluginId, pluginId }),
  });
}
