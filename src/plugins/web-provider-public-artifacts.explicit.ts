// Extracts explicit public artifacts from web provider plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { loadBundledPublicArtifactEntries } from "./public-artifact-factories.js";
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
  return loadBundledPublicArtifactEntries({
    ...params,
    artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
    suffix: "WebSearchProvider",
    isArtifact: (value): value is WebSearchProviderPlugin => isWebProviderPlugin(value),
    partialFailureLabel: "web providers",
  });
}

export function loadBundledWebFetchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebFetchProviderEntry[] | null {
  return loadBundledPublicArtifactEntries({
    ...params,
    artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
    suffix: "WebFetchProvider",
    isArtifact: (value): value is WebFetchProviderPlugin => isWebProviderPlugin(value),
    partialFailureLabel: "web providers",
  });
}

function loadBundledRuntimeWebFetchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebFetchProviderEntry[] | null {
  return loadBundledPublicArtifactEntries({
    ...params,
    artifactCandidates: WEB_FETCH_RUNTIME_ARTIFACT_CANDIDATES,
    suffix: "WebFetchProvider",
    isArtifact: (value): value is WebFetchProviderPlugin => isWebProviderPlugin(value),
    partialFailureLabel: "web providers",
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
