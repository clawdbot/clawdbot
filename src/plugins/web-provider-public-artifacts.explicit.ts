import {
  loadBundledPluginPublicArtifactModuleSync,
  resolveBundledPluginPublicArtifactPath,
} from "./public-surface-loader.js";
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
const WEB_SEARCH_RUNTIME_ARTIFACT_CANDIDATES = ["web-search-provider.js", "web-search.js"] as const;
const WEB_FETCH_ARTIFACT_CANDIDATES = [
  "web-fetch-contract-api.js",
  "web-fetch-provider.js",
  "web-fetch.js",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function isWebSearchProviderPlugin(value: unknown): value is WebSearchProviderPlugin {
  return isWebProviderPlugin(value);
}

function isWebFetchProviderPlugin(value: unknown): value is WebFetchProviderPlugin {
  return isWebProviderPlugin(value);
}

function collectProviderFactories<TProvider>(params: {
  mod: Record<string, unknown>;
  suffix: string;
  isProvider: (value: unknown) => value is TProvider;
}): TProvider[] {
  const providers: TProvider[] = [];
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
    const candidate = exported();
    if (params.isProvider(candidate)) {
      providers.push(candidate);
    }
  }
  return providers;
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
  artifactCandidates: readonly string[];
}): Record<string, unknown> | null {
  for (const artifactBasename of params.artifactCandidates) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: params.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function normalizeExplicitBundledPluginIds(pluginIds: readonly string[]): string[] {
  return [...new Set(pluginIds)].toSorted((left, right) => left.localeCompare(right));
}

function loadBundledProviderEntriesFromDir<TProvider extends object>(params: {
  dirName: string;
  pluginId: string;
  artifactCandidates: readonly string[];
  suffix: string;
  isProvider: (value: unknown) => value is TProvider;
}): Array<TProvider & { pluginId: string }> | null {
  const mod = tryLoadBundledPublicArtifactModule({
    dirName: params.dirName,
    artifactCandidates: params.artifactCandidates,
  });
  if (!mod) {
    return null;
  }
  const providers = collectProviderFactories({
    mod,
    suffix: params.suffix,
    isProvider: params.isProvider,
  });
  if (providers.length === 0) {
    return null;
  }
  return providers.map((provider) => Object.assign({}, provider, { pluginId: params.pluginId }));
}

export function loadBundledWebSearchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebSearchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebSearchProviderPlugin>({
    dirName: params.dirName,
    pluginId: params.pluginId,
    artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
    suffix: "WebSearchProvider",
    isProvider: isWebSearchProviderPlugin,
  });
}

function loadBundledRuntimeWebSearchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebSearchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebSearchProviderPlugin>({
    dirName: params.dirName,
    pluginId: params.pluginId,
    artifactCandidates: WEB_SEARCH_RUNTIME_ARTIFACT_CANDIDATES,
    suffix: "WebSearchProvider",
    isProvider: isWebSearchProviderPlugin,
  });
}

export function loadBundledWebFetchProviderEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebFetchProviderEntry[] | null {
  return loadBundledProviderEntriesFromDir<WebFetchProviderPlugin>({
    dirName: params.dirName,
    pluginId: params.pluginId,
    artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
    suffix: "WebFetchProvider",
    isProvider: isWebFetchProviderPlugin,
  });
}

export function resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null {
  const providers: PluginWebSearchProviderEntry[] = [];
  for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
    const loadedProviders = loadBundledWebSearchProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null {
  const providers: PluginWebSearchProviderEntry[] = [];
  for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
    const loadedProviders = loadBundledRuntimeWebSearchProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(params: {
  onlyPluginIds: readonly string[];
}): PluginWebFetchProviderEntry[] | null {
  const providers: PluginWebFetchProviderEntry[] = [];
  for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
    const loadedProviders = loadBundledWebFetchProviderEntriesFromDir({
      dirName: pluginId,
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

function hasBundledPublicArtifactCandidate(params: {
  dirName: string;
  artifactCandidates: readonly string[];
}): boolean {
  return params.artifactCandidates.some((artifactBasename) =>
    Boolean(resolveBundledPluginPublicArtifactPath({ dirName: params.dirName, artifactBasename })),
  );
}

export function hasBundledWebSearchProviderPublicArtifact(pluginId: string): boolean {
  return hasBundledPublicArtifactCandidate({
    dirName: pluginId,
    artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
  });
}

export function hasBundledWebFetchProviderPublicArtifact(pluginId: string): boolean {
  return hasBundledPublicArtifactCandidate({
    dirName: pluginId,
    artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
  });
}
