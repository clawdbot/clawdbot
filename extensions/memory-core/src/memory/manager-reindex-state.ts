import {
  hashText,
  normalizeExtraMemoryPaths,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  sources?: MemorySource[];
  scopeHash?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
  ftsTokenizer?: string;
};

export function resolveConfiguredSourcesForMeta(sources: Iterable<MemorySource>): MemorySource[] {
  const normalized = Array.from(sources)
    .filter((source): source is MemorySource => source === "memory" || source === "sessions")
    .toSorted();
  return normalized.length > 0 ? normalized : ["memory"];
}

export function normalizeMetaSources(meta: MemoryIndexMeta): MemorySource[] {
  if (!Array.isArray(meta.sources)) {
    // Backward compatibility for older indexes that did not persist sources.
    return ["memory"];
  }
  const normalized = Array.from(
    new Set(
      meta.sources.filter(
        (source): source is MemorySource => source === "memory" || source === "sessions",
      ),
    ),
  ).toSorted();
  return normalized.length > 0 ? normalized : ["memory"];
}

export function configuredMetaSourcesDiffer(params: {
  meta: MemoryIndexMeta;
  configuredSources: MemorySource[];
}): boolean {
  const metaSources = normalizeMetaSources(params.meta);
  if (metaSources.length !== params.configuredSources.length) {
    return true;
  }
  return metaSources.some((source, index) => source !== params.configuredSources[index]);
}

export function resolveConfiguredScopeHash(params: {
  workspaceDir: string;
  extraPaths?: string[];
  multimodal: {
    enabled: boolean;
    modalities: string[];
    maxFileBytes: number;
  };
}): string {
  const extraPaths = normalizeExtraMemoryPaths(params.workspaceDir, params.extraPaths)
    .map((value) => value.replace(/\\/g, "/"))
    .toSorted();
  return hashText(
    JSON.stringify({
      extraPaths,
      multimodal: {
        enabled: params.multimodal.enabled,
        modalities: [...params.multimodal.modalities].toSorted(),
        maxFileBytes: params.multimodal.maxFileBytes,
      },
    }),
  );
}

export function shouldRunFullMemoryReindex(params: {
  meta: MemoryIndexMeta | null;
  provider: { id: string; model: string } | null;
  providerKey?: string;
  configuredSources: MemorySource[];
  configuredScopeHash: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorReady: boolean;
  ftsTokenizer: string;
}): boolean {
  const { meta } = params;
  return (
    !meta ||
    (params.provider ? meta.model !== params.provider.model : meta.model !== "fts-only") ||
    (params.provider ? meta.provider !== params.provider.id : meta.provider !== "none") ||
    meta.providerKey !== params.providerKey ||
    configuredMetaSourcesDiffer({
      meta,
      configuredSources: params.configuredSources,
    }) ||
    meta.scopeHash !== params.configuredScopeHash ||
    meta.chunkTokens !== params.chunkTokens ||
    meta.chunkOverlap !== params.chunkOverlap ||
    (params.vectorReady && !meta.vectorDims) ||
    (meta.ftsTokenizer ?? "unicode61") !== params.ftsTokenizer
  );
}
