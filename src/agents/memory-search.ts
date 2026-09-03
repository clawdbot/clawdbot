/**
 * Resolves memory-search source, sync, and ranking configuration.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig, MemorySearchConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  normalizeConfiguredMemoryExtraPaths,
  resolveRememberAcrossConversations,
} from "../memory-host-sdk/host/config-utils.js";
import type { MemoryExtraPath } from "../memory-host-sdk/host/types.js";
import {
  isMemoryMultimodalEnabled,
  normalizeMemoryMultimodalSettings,
  type MemoryMultimodalSettings,
} from "../memory-host-sdk/multimodal.js";
import { getMemoryEmbeddingProvider } from "../plugins/memory-embedding-provider-runtime.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import { runtimeMemorySecretOwnerId } from "../secrets/runtime-memory-secret-owner.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { clampNumber } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ResolvedMemorySearchConfig = {
  enabled: boolean;
  rememberAcrossConversations: boolean;
  /** Sources indexed by the manager. */
  sources: Array<"memory" | "sessions">;
  /** Sources searched when memory_search omits an explicit corpus. */
  searchSources: Array<"memory" | "sessions">;
  extraPaths: MemoryExtraPath[];
  multimodal: MemoryMultimodalSettings;
  provider: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
    nonBatchConcurrency?: number;
    batch?: {
      enabled: boolean;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMinutes: number;
    };
  };
  experimental: {
    sessionMemory: boolean;
  };
  fallback: string;
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  outputDimensionality?: number;
  local: {
    modelPath?: string;
    modelCacheDir?: string;
    contextSize?: number | "auto";
  };
  store: {
    driver: "sqlite";
    databasePath: string;
    fts: {
      tokenizer: "unicode61" | "trigram";
    };
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  chunking: {
    tokens: number;
    overlap: number;
  };
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
    embeddingBatchTimeoutSeconds: number | undefined;
    sessions: {
      deltaBytes: number;
      deltaMessages: number;
      postCompactionForce: boolean;
    };
  };
  query: {
    maxResults: number;
    minScore: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
      mmr: {
        enabled: boolean;
        lambda: number;
      };
      temporalDecay: {
        enabled: boolean;
        halfLifeDays: number;
      };
    };
  };
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
};

export type ResolvedMemorySearchSyncConfig = ResolvedMemorySearchConfig["sync"];

const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_SESSION_DELTA_BYTES = 100_000;
const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_HYBRID_ENABLED = true;
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;
const DEFAULT_HYBRID_TEXT_WEIGHT = 0.3;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MMR_ENABLED = true;
const DEFAULT_MMR_LAMBDA = 0.7;
const DEFAULT_TEMPORAL_DECAY_ENABLED = true;
const DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;
const DEFAULT_CACHE_ENABLED = true;
// LRU bound for the embedding cache. #111382 purged the operator knob but left the
// built-in default unset, so pruneEmbeddingCacheIfNeeded early-returns and the cache grows
// without limit. Must stay above a typical live chunk count: a cap below the working set
// evicts rows the next sync needs and forces paid re-embedding.
const DEFAULT_CACHE_MAX_ENTRIES = 50_000;
const DEFAULT_SOURCES: Array<"memory" | "sessions"> = ["memory"];
const DEFAULT_MEMORY_EMBEDDING_PROVIDER = "openai";
const DEFAULT_REMOTE_BATCH_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REMOTE_BATCH_TIMEOUT_MINUTES = 60;

type ConfiguredMemoryEmbeddingProvider = {
  defaultModel?: string;
  transport?: "local" | "remote";
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
};

function normalizeSources(
  sources: Array<"memory" | "sessions"> | undefined,
  sessionMemoryEnabled: boolean,
): Array<"memory" | "sessions"> {
  const normalized = new Set<"memory" | "sessions">();
  const input = sources?.length ? sources : DEFAULT_SOURCES;
  for (const source of input) {
    if (source === "memory") {
      normalized.add("memory");
    }
    if (source === "sessions" && sessionMemoryEnabled) {
      normalized.add("sessions");
    }
  }
  if (normalized.size === 0) {
    normalized.add("memory");
  }
  return Array.from(normalized);
}

function getConfiguredMemoryEmbeddingProvider(
  providerId: string,
  cfg: OpenClawConfig,
): ConfiguredMemoryEmbeddingProvider | undefined {
  // `none` is the built-in FTS-only sentinel, never a plugin capability.
  // Avoid cold plugin discovery when semantic memory is intentionally disabled.
  if (normalizeProviderId(providerId) === "none") {
    return undefined;
  }
  return getMemoryEmbeddingProvider(providerId, cfg);
}

/** Resolves indexing eligibility without loading an embedding provider runtime. */
export function resolveMemorySearchIndexConfig(cfg: OpenClawConfig, agentId: string) {
  const defaults = cfg.memory?.search;
  const overrides = resolveAgentConfig(cfg, agentId)?.memory?.search;
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  assertSecretOwnerAvailable("capability", runtimeMemorySecretOwnerId(agentId));
  const rememberAcrossConversations = resolveRememberAcrossConversations(cfg, agentId);
  const configuredSessionMemory =
    overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? false;
  const sessionMemory = rememberAcrossConversations || configuredSessionMemory;
  const configuredSources = overrides?.sources ?? defaults?.sources;
  const searchSources = normalizeSources(
    configuredSources,
    configuredSessionMemory ||
      (rememberAcrossConversations && configuredSources?.includes("sessions") === true),
  );
  const sources = normalizeSources(
    rememberAcrossConversations ? [...searchSources, "sessions"] : configuredSources,
    sessionMemory,
  );
  return {
    enabled,
    rememberAcrossConversations,
    sources,
    searchSources,
    experimental: { sessionMemory },
    sync: resolveSyncConfig(),
  };
}

function mergeConfig(
  cfg: OpenClawConfig,
  defaults: MemorySearchConfig | undefined,
  overrides: MemorySearchConfig | undefined,
  agentId: string,
): ResolvedMemorySearchConfig | null {
  const indexConfig = resolveMemorySearchIndexConfig(cfg, agentId);
  if (!indexConfig) {
    return null;
  }
  const rawProvider = overrides?.provider ?? defaults?.provider;
  const provider =
    rawProvider?.trim() === "auto"
      ? DEFAULT_MEMORY_EMBEDDING_PROVIDER
      : rawProvider?.trim() || DEFAULT_MEMORY_EMBEDDING_PROVIDER;
  const primaryAdapter = getConfiguredMemoryEmbeddingProvider(provider, cfg);
  const defaultRemote = defaults?.remote;
  const overrideRemote = overrides?.remote;
  const fallback = overrides?.fallback ?? defaults?.fallback ?? "none";
  const fallbackAdapter =
    normalizeProviderId(provider) !== "none" && fallback && fallback !== "none"
      ? getConfiguredMemoryEmbeddingProvider(fallback, cfg)
      : undefined;
  const hasRemoteConfig = Boolean(
    overrideRemote?.baseUrl ||
    overrideRemote?.apiKey ||
    overrideRemote?.headers ||
    defaultRemote?.baseUrl ||
    defaultRemote?.apiKey ||
    defaultRemote?.headers ||
    false,
  );
  const includeRemote =
    hasRemoteConfig ||
    primaryAdapter?.transport !== "local" ||
    fallbackAdapter?.transport === "remote";
  const batch = {
    enabled: overrideRemote?.batch?.enabled ?? defaultRemote?.batch?.enabled ?? false,
    wait: true,
    concurrency: 2,
    pollIntervalMs: DEFAULT_REMOTE_BATCH_POLL_INTERVAL_MS,
    timeoutMinutes: DEFAULT_REMOTE_BATCH_TIMEOUT_MINUTES,
  };
  const remote = includeRemote
    ? {
        baseUrl: overrideRemote?.baseUrl ?? defaultRemote?.baseUrl,
        apiKey: overrideRemote?.apiKey ?? defaultRemote?.apiKey,
        headers: overrideRemote?.headers ?? defaultRemote?.headers,
        batch,
      }
    : undefined;
  const modelDefault = primaryAdapter?.defaultModel;
  const model = overrides?.model ?? defaults?.model ?? modelDefault ?? "";
  const inputType = overrides?.inputType?.trim() || defaults?.inputType?.trim() || undefined;
  const queryInputType =
    overrides?.queryInputType?.trim() || defaults?.queryInputType?.trim() || undefined;
  const documentInputType =
    overrides?.documentInputType?.trim() || defaults?.documentInputType?.trim() || undefined;
  const outputDimensionality = overrides?.outputDimensionality ?? defaults?.outputDimensionality;
  const local = {
    modelPath: overrides?.local?.modelPath ?? defaults?.local?.modelPath,
  };
  const extraPaths = normalizeConfiguredMemoryExtraPaths([
    ...(defaults?.extraPaths ?? []),
    ...(overrides?.extraPaths ?? []),
  ]);
  const multimodal = normalizeMemoryMultimodalSettings({
    enabled: overrides?.multimodal?.enabled ?? defaults?.multimodal?.enabled,
    modalities: overrides?.multimodal?.modalities ?? defaults?.multimodal?.modalities,
    maxFileBytes: overrides?.multimodal?.maxFileBytes ?? defaults?.multimodal?.maxFileBytes,
  });
  const vector = {
    enabled: overrides?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled ?? true,
    extensionPath:
      overrides?.store?.vector?.extensionPath ?? defaults?.store?.vector?.extensionPath,
  };
  const fts = {
    tokenizer: overrides?.store?.fts?.tokenizer ?? defaults?.store?.fts?.tokenizer ?? "unicode61",
  };
  const store = {
    driver: "sqlite" as const,
    databasePath: resolveOpenClawAgentSqlitePath({ agentId, env: process.env }),
    fts,
    vector,
  };
  const chunking = {
    tokens: DEFAULT_CHUNK_TOKENS,
    overlap: DEFAULT_CHUNK_OVERLAP,
  };
  const query = {
    maxResults: overrides?.query?.maxResults ?? defaults?.query?.maxResults ?? DEFAULT_MAX_RESULTS,
    minScore: overrides?.query?.minScore ?? defaults?.query?.minScore ?? DEFAULT_MIN_SCORE,
  };
  const hybrid = {
    enabled: DEFAULT_HYBRID_ENABLED,
    vectorWeight: DEFAULT_HYBRID_VECTOR_WEIGHT,
    textWeight: DEFAULT_HYBRID_TEXT_WEIGHT,
    candidateMultiplier: DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
    mmr: {
      enabled: DEFAULT_MMR_ENABLED,
      lambda: DEFAULT_MMR_LAMBDA,
    },
    temporalDecay: {
      enabled: DEFAULT_TEMPORAL_DECAY_ENABLED,
      halfLifeDays: DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS,
    },
  };
  const cache = {
    enabled: overrides?.cache?.enabled ?? defaults?.cache?.enabled ?? DEFAULT_CACHE_ENABLED,
    maxEntries: DEFAULT_CACHE_MAX_ENTRIES,
  };

  const minScore = clampNumber(query.minScore, 0, 1);
  return {
    ...indexConfig,
    extraPaths,
    multimodal,
    provider,
    remote,
    fallback,
    model,
    inputType,
    queryInputType,
    documentInputType,
    outputDimensionality,
    local,
    store,
    chunking,
    query: {
      ...query,
      minScore,
      hybrid,
    },
    cache,
  };
}

function resolveSyncConfig(): ResolvedMemorySearchSyncConfig {
  return {
    onSessionStart: true,
    onSearch: true,
    watch: true,
    watchDebounceMs: DEFAULT_WATCH_DEBOUNCE_MS,
    intervalMinutes: 0,
    embeddingBatchTimeoutSeconds: undefined,
    sessions: {
      deltaBytes: DEFAULT_SESSION_DELTA_BYTES,
      deltaMessages: DEFAULT_SESSION_DELTA_MESSAGES,
      postCompactionForce: true,
    },
  };
}

export function resolveMemorySearchConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedMemorySearchConfig | null {
  const defaults = cfg.memory?.search;
  const overrides = resolveAgentConfig(cfg, agentId)?.memory?.search;
  const resolved = mergeConfig(cfg, defaults, overrides, agentId);
  if (!resolved) {
    return null;
  }
  const isFtsOnly = normalizeProviderId(resolved.provider) === "none";
  const multimodalActive = isMemoryMultimodalEnabled(resolved.multimodal);
  const multimodalProvider = isFtsOnly
    ? undefined
    : getConfiguredMemoryEmbeddingProvider(resolved.provider, cfg);
  // Custom provider ids can map to a memory adapter through models.providers.<id>.api.
  // Keep multimodal validation on that config-aware adapter, not the raw id.
  if (
    !isFtsOnly &&
    multimodalActive &&
    multimodalProvider &&
    !(multimodalProvider.supportsMultimodalEmbeddings?.({ model: resolved.model }) ?? false)
  ) {
    throw new Error(
      "memory.search.multimodal requires a provider adapter that supports multimodal embeddings for the configured model.",
    );
  }
  if (multimodalActive && resolved.fallback !== "none") {
    throw new Error(
      'memory.search.multimodal does not support memory.search.fallback. Set fallback to "none".',
    );
  }
  return resolved;
}

export function resolveMemorySearchSyncConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedMemorySearchSyncConfig | null {
  const defaults = cfg.memory?.search;
  const overrides = resolveAgentConfig(cfg, agentId)?.memory?.search;
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  return resolveSyncConfig();
}
