// Memory Core plugin module implements manager reindex state behavior.
import {
  hashText,
  MEMORY_CHUNKING_VERSION,
  normalizeExtraMemoryPathEntries,
  type MemoryExtraPath,
  type MemoryIndexIdentityOwner,
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
  chunkingVersion?: number;
  vectorDims?: number;
  ftsTokenizer?: string;
  provenanceVersion?: number;
};

export const MEMORY_INDEX_PROVENANCE_VERSION = 1;

export type MemoryIndexIdentityCode =
  | "metadata_missing"
  | "provenance_version"
  | "chunking_version"
  | "model"
  | "provider"
  | "provider_settings"
  | "sources"
  | "scope"
  | "chunking"
  | "vector_dims"
  | "fts_tokenizer";

export type MemoryIndexIdentityState =
  | {
      status: "valid";
    }
  | {
      status: "missing";
      reason: string;
      code: "metadata_missing";
      owner: "openclaw";
    }
  | {
      status: "mismatched";
      reason: string;
      code: Exclude<MemoryIndexIdentityCode, "metadata_missing">;
      owner: MemoryIndexIdentityOwner;
    };

export const MISSING_MEMORY_INDEX_IDENTITY: MemoryIndexIdentityState = {
  status: "missing",
  reason: "index metadata is missing",
  code: "metadata_missing",
  owner: "openclaw",
};

export type MemoryIndexProviderIdentity = {
  provider: string;
  model: string;
  providerKey: string;
};

export function resolveMemoryIndexProviderIdentities(params: {
  provider: { id: string; model: string } | null;
  cacheKeyData?: Record<string, unknown>;
  aliases?: Array<{ model: string; cacheKeyData: Record<string, unknown> }>;
}): MemoryIndexProviderIdentity[] {
  const provider = params.provider ?? { id: "none", model: "fts-only" };
  const candidates = [
    {
      model: provider.model,
      cacheKeyData: params.cacheKeyData ?? { provider: provider.id, model: provider.model },
    },
    ...(params.provider ? (params.aliases ?? []) : []),
  ];
  const seen = new Set<string>();
  const identities: MemoryIndexProviderIdentity[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const providerKey = hashText(JSON.stringify(candidate.cacheKeyData));
    const key = `${candidate.model}\u0000${providerKey}`;
    if ((index > 0 && !candidate.model) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    identities.push({
      provider: provider.id,
      model: candidate.model,
      providerKey,
    });
  }
  return identities;
}

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
  extraPaths?: MemoryExtraPath[];
  multimodal: {
    enabled: boolean;
    modalities: string[];
    maxFileBytes: number;
  };
}): string {
  const extraPaths = normalizeExtraMemoryPathEntries(params.workspaceDir, params.extraPaths)
    .map((entry) => {
      const path = entry.path.replaceAll("\\", "/");
      return entry.pattern ? { path, pattern: entry.pattern } : path;
    })
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
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

export function resolveMemoryIndexIdentityState(params: {
  meta: MemoryIndexMeta | null;
  provider: { id: string; model?: string } | null;
  providerKey?: string;
  providerAliases?: Array<Pick<MemoryIndexProviderIdentity, "model" | "providerKey">>;
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
    return MISSING_MEMORY_INDEX_IDENTITY;
  }
  if (meta.provenanceVersion !== MEMORY_INDEX_PROVENANCE_VERSION) {
    return {
      status: "mismatched",
      reason: "index provenance classifier changed",
      code: "provenance_version",
      owner: "openclaw",
    };
  }
  if (meta.chunkingVersion !== MEMORY_CHUNKING_VERSION) {
    return {
      status: "mismatched",
      reason: "index chunking implementation changed",
      code: "chunking_version",
      owner: "openclaw",
    };
  }
  const expectedModel =
    params.provider && params.provider.model === undefined
      ? undefined
      : params.provider?.model?.trim() || "fts-only";
  const matchingModelIdentities = [
    { model: expectedModel, providerKey: params.providerKey },
    ...(params.providerAliases ?? []),
  ].filter((identity) => identity.model === meta.model);
  if (expectedModel !== undefined && matchingModelIdentities.length === 0) {
    return {
      status: "mismatched",
      reason: `index was built for model ${meta.model}, expected ${expectedModel}`,
      code: "model",
      owner: "configuration",
    };
  }
  const expectedProvider = params.provider ? params.provider.id : "none";
  if (meta.provider !== expectedProvider) {
    return {
      status: "mismatched",
      reason: `index was built for provider ${meta.provider}, expected ${expectedProvider}`,
      code: "provider",
      owner: "configuration",
    };
  }
  if (
    expectedModel !== undefined &&
    params.providerKeyKnown !== false &&
    !matchingModelIdentities.some((identity) => identity.providerKey === meta.providerKey)
  ) {
    return {
      status: "mismatched",
      reason: "index provider settings changed",
      code: "provider_settings",
      owner: "configuration",
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
      code: "sources",
      owner: "configuration",
    };
  }
  if (meta.scopeHash !== params.configuredScopeHash) {
    return {
      status: "mismatched",
      reason: "index scope changed",
      code: "scope",
      owner: "configuration",
    };
  }
  if (meta.chunkTokens !== params.chunkTokens || meta.chunkOverlap !== params.chunkOverlap) {
    return {
      status: "mismatched",
      reason: "index chunking changed",
      code: "chunking",
      owner: "configuration",
    };
  }
  if (params.vectorReady && params.hasIndexedChunks !== false && !meta.vectorDims) {
    return {
      status: "mismatched",
      reason: "index vector dimensions are missing",
      code: "vector_dims",
      owner: "configuration",
    };
  }
  if ((meta.ftsTokenizer ?? "unicode61") !== params.ftsTokenizer) {
    return {
      status: "mismatched",
      reason: "index FTS tokenizer changed",
      code: "fts_tokenizer",
      owner: "configuration",
    };
  }
  return { status: "valid" };
}
