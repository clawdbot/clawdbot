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

export type MemoryIndexIdentityState =
  | {
      status: "valid";
    }
  | {
      status: "missing";
      reason: string;
    }
  | {
      status: "mismatched";
      reason: string;
    };

export function resolveConfiguredSourcesForMeta(sources: Iterable<MemorySource>): MemorySource[] {
  const normalized = Array.from(sources)
    .filter((source): source is MemorySource => source === "memory" || source === "sessions")
    .toSorted((left, right) => left.localeCompare(right));
  return normalized.length > 0 ? normalized : ["memory"];
}

function normalizeMetaSources(meta: MemoryIndexMeta): MemorySource[] {
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
  ).toSorted((left, right) => left.localeCompare(right));
  return normalized.length > 0 ? normalized : ["memory"];
}

function configuredMetaSourcesDiffer(params: {
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

export function isMemoryIndexIdentityDirty(params: {
  meta: MemoryIndexMeta | null;
  provider: { id: string; model: string } | null;
  providerKey?: string;
  providerKeyKnown?: boolean;
  configuredSources: MemorySource[];
  configuredScopeHash: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorReady: boolean;
  hasIndexedChunks?: boolean;
  ftsTokenizer: string;
}): boolean {
  return resolveMemoryIndexIdentityState(params).status !== "valid";
}

export function resolveMemoryIndexIdentityState(params: {
  meta: MemoryIndexMeta | null;
  provider: { id: string; model: string } | null;
  providerKey?: string;
  providerKeyKnown?: boolean;
  configuredSources: MemorySource[];
  configuredScopeHash: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorReady: boolean;
  hasIndexedChunks?: boolean;
  ftsTokenizer: string;
}): MemoryIndexIdentityState {
  const { meta } = params;
  if (!meta) {
    return { status: "missing", reason: "index metadata is missing" };
  }
  const expectedModel = params.provider ? params.provider.model : "fts-only";
  if (meta.model !== expectedModel) {
    return {
      status: "mismatched",
      reason: `index was built for model ${meta.model}, expected ${expectedModel}`,
    };
  }
  const expectedProvider = params.provider ? params.provider.id : "none";
  if (meta.provider !== expectedProvider) {
    return {
      status: "mismatched",
      reason: `index was built for provider ${meta.provider}, expected ${expectedProvider}`,
    };
  }
  if (params.providerKeyKnown !== false && meta.providerKey !== params.providerKey) {
    return {
      status: "mismatched",
      reason: "index provider settings changed",
    };
  }
  if (
    configuredMetaSourcesDiffer({
      meta,
      configuredSources: params.configuredSources,
    })
  ) {
    return {
      status: "mismatched",
      reason: "index sources changed",
    };
  }
  if (meta.scopeHash !== params.configuredScopeHash) {
    return {
      status: "mismatched",
      reason: "index scope changed",
    };
  }
  if (meta.chunkTokens !== params.chunkTokens || meta.chunkOverlap !== params.chunkOverlap) {
    return {
      status: "mismatched",
      reason: "index chunking changed",
    };
  }
  if (params.vectorReady && params.hasIndexedChunks !== false && !meta.vectorDims) {
    return {
      status: "mismatched",
      reason: "index vector dimensions are missing",
    };
  }
  if ((meta.ftsTokenizer ?? "unicode61") !== params.ftsTokenizer) {
    return {
      status: "mismatched",
      reason: "index FTS tokenizer changed",
    };
  }
  return { status: "valid" };
}
