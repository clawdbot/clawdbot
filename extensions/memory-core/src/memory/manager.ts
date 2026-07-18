// Memory Core plugin module implements manager behavior.
import type { DatabaseSync } from "node:sqlite";
import type { FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { listRegisteredMemoryEmbeddingProviderAdapters } from "openclaw/plugin-sdk/memory-core-host-embedding-registry";
import {
  createSubsystemLogger,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { extractKeywords } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  readMemoryFile,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  type MemoryEmbeddingProbeResult,
  type MemoryProviderStatus,
  type MemorySearchManager,
  type MemorySearchRuntimeDebug,
  type MemorySearchResult,
  type MemorySessionSyncTarget,
  type MemorySource,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveMemoryCoreLocalServiceHostIdentity,
  type MemoryCoreAcquireLocalService,
} from "./embedding-local-service.js";
import {
  createEmbeddingProvider,
  resolveEmbeddingProviderAdapterTransport,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
import {
  bm25RankToScore,
  buildFtsQuery,
  mergeHybridResults,
  scoreExactPathTieForTemporalDecay,
} from "./hybrid.js";
import { awaitPendingManagerWork, startAsyncSearchSync } from "./manager-async-state.js";
import { MEMORY_BATCH_FAILURE_LIMIT } from "./manager-batch-state.js";
import {
  closeManagedCacheEntries,
  getOrCreateManagedCacheEntry,
  resolveSingletonManagedCache,
} from "./manager-cache.js";
import { closeMemoryDatabase } from "./manager-db.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import { isLocalEmbeddingWorkerFailure } from "./manager-local-worker-errors.js";
import {
  createDegradedMemoryProviderLifecycle,
  createPendingMemoryProviderLifecycle,
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderState,
  type MemoryProviderLifecycleState,
} from "./manager-provider-state.js";
import type { MemoryIndexIdentityState } from "./manager-reindex-state.js";
import { resolveMemorySearchPreflight } from "./manager-search-preflight.js";
import {
  resolveExactPathSpecificity,
  searchKeyword,
  searchPathKeyword,
  searchVector,
  type ExactPathSpecificity,
} from "./manager-search.js";
import {
  collectMemoryStatusAggregate,
  resolveInitialMemoryDirty,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";
import {
  enqueueMemoryTargetedSessionSync,
  runMemorySyncWithReadonlyRecovery,
  type MemoryReadonlyRecoveryState,
} from "./manager-sync-control.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

function getLocalEmbeddingRuntimeFacts(provider: EmbeddingProvider | null): unknown {
  if (!provider) {
    return undefined;
  }
  const getRuntimeFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
  return typeof getRuntimeFacts === "function" ? getRuntimeFacts() : undefined;
}

const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = MEMORY_INDEX_VECTOR_TABLE;
const FTS_TABLE = MEMORY_INDEX_FTS_TABLE;
const PATH_FTS_TABLE = MEMORY_INDEX_PATHS_FTS_TABLE;
const EMBEDDING_CACHE_TABLE = MEMORY_EMBEDDING_CACHE_TABLE;
const MEMORY_INDEX_MANAGER_CACHE_KEY = Symbol.for("openclaw.memoryIndexManagerCache");
const EMBEDDING_PROBE_CACHE_TTL_MS = 30_000;
const KEYWORD_FALLBACK_SEARCH_TERM_LIMIT = 6;
const EXACT_PATH_CANDIDATE_LIMIT = 200;
const log = createSubsystemLogger("memory");
type MemoryIndexManagerPurpose = "default" | "status" | "cli";
type MemoryEmbeddingProviderRequirement = {
  mode: "fts-only" | "optional" | "required";
  provider: string;
  configuredProvider?: string;
};

const { cache: INDEX_CACHE, pending: INDEX_CACHE_PENDING } =
  resolveSingletonManagedCache<MemoryIndexManager>(MEMORY_INDEX_MANAGER_CACHE_KEY);

type EmbeddingProbeCacheEntry = {
  result: MemoryEmbeddingProbeResult;
  checkedAtMs: number;
  expireAtMs: number;
};

type KeywordSearchHit = MemorySearchResult & {
  id: string;
  textScore: number;
  pathScore: number;
  exactPathSpecificity: ExactPathSpecificity;
};

function compareKeywordSearchHits(
  a: KeywordSearchHit,
  b: KeywordSearchHit,
  preferExactBody = true,
): number {
  const specificityDelta = b.exactPathSpecificity - a.exactPathSpecificity;
  if (specificityDelta !== 0) {
    return specificityDelta;
  }
  if (preferExactBody && a.exactPathSpecificity > 0) {
    const bodyPresenceDelta = Number(b.textScore > 0) - Number(a.textScore > 0);
    if (bodyPresenceDelta !== 0) {
      return bodyPresenceDelta;
    }
  }
  // Score carries body relevance plus any configured decay. Exact tiers ignore
  // path BM25 because specificity already owns path precedence.
  const relevanceDelta = b.score - a.score;
  if (relevanceDelta !== 0) {
    return relevanceDelta;
  }
  const textDelta = b.textScore - a.textScore;
  if (textDelta !== 0) {
    return textDelta;
  }
  if (a.exactPathSpecificity === 0) {
    const pathDelta = b.pathScore - a.pathScore;
    if (pathDelta !== 0) {
      return pathDelta;
    }
  }
  return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.id.localeCompare(b.id);
}

const EMBEDDING_PROBE_CACHE = new Map<string, EmbeddingProbeCacheEntry>();

export async function closeAllMemoryIndexManagers(): Promise<void> {
  EMBEDDING_PROBE_CACHE.clear();
  await closeManagedCacheEntries({
    cache: INDEX_CACHE,
    pending: INDEX_CACHE_PENDING,
    onCloseError: (err) => {
      log.warn(`failed to close memory index manager: ${String(err)}`);
    },
  });
}

export async function closeMemoryIndexManagersForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  await closeMemoryIndexManagersForScope({
    agentId: params.agentId,
    workspaceDir,
    purpose: "default",
  });
}

function resolveEffectiveMemorySearchSettings(
  settings: ResolvedMemorySearchConfig,
): ResolvedMemorySearchConfig {
  if (settings.provider !== "none" || !settings.store.vector.enabled) {
    return settings;
  }
  return {
    ...settings,
    store: {
      ...settings.store,
      vector: {
        ...settings.store.vector,
        enabled: false,
      },
    },
  };
}

function resolveConfiguredMemoryEmbeddingProvider(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const agentEntry = params.cfg.agents?.list?.find(
    (entry) => entry && normalizeAgentId(entry.id) === normalizedAgentId,
  );
  return agentEntry?.memorySearch?.provider ?? params.cfg.agents?.defaults?.memorySearch?.provider;
}

function resolveMemoryEmbeddingProviderRequirement(params: {
  cfg: OpenClawConfig;
  agentId: string;
  settings: ResolvedMemorySearchConfig;
}): MemoryEmbeddingProviderRequirement {
  const configuredProvider = resolveConfiguredMemoryEmbeddingProvider(params)?.trim();
  if (params.settings.provider === "none" || configuredProvider === "none") {
    return { mode: "fts-only", provider: params.settings.provider };
  }
  const adapterTransport = resolveEmbeddingProviderAdapterTransport(
    params.settings.provider,
    params.cfg,
  );
  if (!configuredProvider || configuredProvider === "auto" || adapterTransport === "local") {
    return { mode: "optional", provider: params.settings.provider };
  }
  return {
    mode: "required",
    provider: params.settings.provider,
    configuredProvider,
  };
}

function resolveMemoryIndexManagerCacheKey(params: {
  agentId: string;
  workspaceDir: string;
  settings: ResolvedMemorySearchConfig;
  providerRequirement: MemoryEmbeddingProviderRequirement;
  purpose: MemoryIndexManagerPurpose;
  acquireLocalService?: MemoryCoreAcquireLocalService;
}): string {
  return [
    params.agentId,
    params.workspaceDir,
    JSON.stringify(params.settings),
    JSON.stringify(params.providerRequirement),
    resolveMemoryCoreLocalServiceHostIdentity(params.acquireLocalService),
    params.purpose,
  ].join(":");
}

function isMemoryIndexManagerCacheKeyInScope(
  key: string,
  params: {
    agentId: string;
    workspaceDir: string;
    purpose: MemoryIndexManagerPurpose;
  },
): boolean {
  return (
    key.startsWith(`${params.agentId}:${params.workspaceDir}:`) &&
    key.endsWith(`:${params.purpose}`)
  );
}

async function closeMemoryIndexManagersForScope(params: {
  agentId: string;
  workspaceDir: string;
  purpose: MemoryIndexManagerPurpose;
  exceptKey?: string;
}): Promise<void> {
  const isScopedKey = (key: string) =>
    key !== params.exceptKey && isMemoryIndexManagerCacheKeyInScope(key, params);
  const pending = Array.from(INDEX_CACHE_PENDING.entries())
    .filter(([key]) => isScopedKey(key))
    .map(([, value]) => value);
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  const entries = Array.from(INDEX_CACHE.entries()).filter(([key]) => isScopedKey(key));
  for (const [key, manager] of entries) {
    INDEX_CACHE.delete(key);
    try {
      await manager.close();
    } catch (err) {
      log.warn(`failed to close memory index manager for agent ${params.agentId}: ${String(err)}`);
    }
  }
}

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey: string;
  private readonly purpose: MemoryIndexManagerPurpose;
  protected override readonly acquireLocalService?: MemoryCoreAcquireLocalService;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  private readonly providerRequirement: MemoryEmbeddingProviderRequirement;
  protected override provider: EmbeddingProvider | null;
  private readonly requestedProvider: EmbeddingProviderRequest;
  private providerInitPromise: Promise<void> | null = null;
  private providerInitialized = false;
  protected override fallbackFrom?: EmbeddingProviderId;
  protected override fallbackReason?: string;
  protected providerUnavailableReason?: string;
  protected override providerLifecycle: MemoryProviderLifecycleState;
  protected override providerRuntime?: EmbeddingProviderRuntime;
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0;
  protected batchFailureLastError?: string;
  protected batchFailureLastProvider?: string;
  protected batchFailureLock: Promise<void> = Promise.resolve();
  protected db: DatabaseSync;
  protected override readonly sources: Set<MemorySource>;
  protected override providerKey: string;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    semanticAvailable?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected override readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  protected override vectorReady: Promise<boolean> | null = null;
  protected override watcher: FSWatcher | null = null;
  protected override watchTimer: NodeJS.Timeout | null = null;
  protected override sessionWatchTimer: NodeJS.Timeout | null = null;
  protected override sessionUnsubscribe: (() => void) | null = null;
  protected override intervalTimer: NodeJS.Timeout | null = null;
  protected override memoryWatchPressureStartupTimer: NodeJS.Timeout | null = null;
  protected override closed = false;
  protected override dirty = false;
  protected override sessionsDirty = false;
  protected override sessionsDirtyFiles = new Set<string>();
  protected override sessionPendingFiles = new Set<string>();
  protected override sessionPendingTargets = new Map<string, MemorySessionSyncTarget>();
  private indexIdentityDirty = false;
  protected override sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;
  private queuedArchiveFiles = new Set<string>();
  private queuedSessions = new Map<string, MemorySessionSyncTarget>();
  private queuedSessionSync: Promise<void> | null = null;
  private readonlyRecoveryAttempts = 0;
  private readonlyRecoverySuccesses = 0;
  private readonlyRecoveryFailures = 0;
  private readonlyRecoveryLastError?: string;
  private indexIdentityState: MemoryIndexIdentityState = {
    status: "missing",
    reason: "index metadata is missing",
  };

  private static async loadProviderResult(params: {
    cfg: OpenClawConfig;
    agentId: string;
    settings: ResolvedMemorySearchConfig;
    acquireLocalService?: MemoryCoreAcquireLocalService;
  }): Promise<EmbeddingProviderResult> {
    return await createEmbeddingProvider({
      config: params.cfg,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      ...(params.acquireLocalService ? { acquireLocalService: params.acquireLocalService } : {}),
      ...resolveMemoryPrimaryProviderRequest({ settings: params.settings }),
    });
  }

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: MemoryIndexManagerPurpose;
    acquireLocalService?: MemoryCoreAcquireLocalService;
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const purpose =
      params.purpose === "status" || params.purpose === "cli" ? params.purpose : "default";
    const providerRequirement = resolveMemoryEmbeddingProviderRequirement({
      cfg,
      agentId,
      settings,
    });
    const key = resolveMemoryIndexManagerCacheKey({
      agentId,
      workspaceDir,
      settings,
      providerRequirement,
      purpose,
      acquireLocalService: params.acquireLocalService,
    });
    const transient = purpose === "status" || purpose === "cli";
    if (!transient) {
      await closeMemoryIndexManagersForScope({
        agentId,
        workspaceDir,
        purpose,
        exceptKey: key,
      });
    }
    return await getOrCreateManagedCacheEntry({
      cache: INDEX_CACHE,
      pending: INDEX_CACHE_PENDING,
      key,
      bypassCache: transient,
      create: async () => {
        const manager = new MemoryIndexManager({
          cacheKey: key,
          cfg,
          agentId,
          workspaceDir,
          settings,
          providerRequirement,
          purpose: params.purpose,
          acquireLocalService: params.acquireLocalService,
        });
        // Lightweight dirty-file detection for status mode: check for unindexed
        // session files on disk without triggering a full sync. This runs before
        // any caller reads manager.status(), so the dirty flag is accurate when
        // status() reads sessionsDirty.
        if (purpose === "status" && manager.sources.has("sessions")) {
          try {
            await manager.markSessionStartupCatchupDirtyFiles();
          } catch (err) {
            log.warn("memory status session dirty detection failed: " + String(err));
          }
        }
        return manager;
      },
    });
  }

  private constructor(params: {
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerRequirement: MemoryEmbeddingProviderRequirement;
    providerResult?: EmbeddingProviderResult;
    purpose?: MemoryIndexManagerPurpose;
    acquireLocalService?: MemoryCoreAcquireLocalService;
  }) {
    super();
    const effectiveSettings = resolveEffectiveMemorySearchSettings(params.settings);
    this.cacheKey = params.cacheKey;
    this.acquireLocalService = params.acquireLocalService;
    this.purpose =
      params.purpose === "status" || params.purpose === "cli" ? params.purpose : "default";
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = effectiveSettings;
    this.providerRequirement = params.providerRequirement;
    this.provider = null;
    this.requestedProvider = effectiveSettings.provider;
    this.providerLifecycle = createPendingMemoryProviderLifecycle(this.requestedProvider);
    if (params.providerResult) {
      this.applyProviderResult(params.providerResult);
    }
    this.sources = new Set(effectiveSettings.sources);
    this.db = this.openDatabase();
    try {
      this.providerKey = this.computeProviderKey();
      this.cache = {
        enabled: effectiveSettings.cache.enabled,
        maxEntries: effectiveSettings.cache.maxEntries,
      };
      this.fts = { enabled: effectiveSettings.query.hybrid.enabled, available: false };
      this.ensureSchema();
      this.vector = {
        enabled: effectiveSettings.store.vector.enabled,
        available: null,
        extensionPath: effectiveSettings.store.vector.extensionPath,
      };
      const meta = this.readMeta();
      if (meta?.vectorDims) {
        this.vector.dims = meta.vectorDims;
      }
      const initialIndexIdentity = this.resolveCurrentIndexIdentityState({
        meta,
        providerKeyKnown: Boolean(params.providerResult),
      });
      this.indexIdentityState = initialIndexIdentity;
      this.indexIdentityDirty =
        initialIndexIdentity.status === "mismatched" ||
        (initialIndexIdentity.status === "missing" && this.sources.has("memory"));
      const transient = params.purpose === "status" || params.purpose === "cli";
      if (!transient) {
        this.ensureWatcher();
        this.ensureSessionListener();
        this.ensureIntervalSync();
      }
      this.dirty = resolveInitialMemoryDirty({
        hasMemorySource: this.sources.has("memory"),
        statusOnly: params.purpose === "status",
        hasIndexedMeta: Boolean(meta),
      });
      this.batch = this.resolveBatchConfig();
      if (!transient) {
        this.ensureSessionStartupCatchup();
      }
    } catch (err) {
      closeMemoryDatabase(this.db);
      throw err;
    }
  }

  private applyProviderResult(providerResult: EmbeddingProviderResult): void {
    const providerState = resolveMemoryProviderState(providerResult);
    this.provider = providerState.provider;
    this.fallbackFrom = providerState.fallbackFrom;
    this.fallbackReason = providerState.fallbackReason;
    this.providerUnavailableReason = providerState.providerUnavailableReason;
    this.providerLifecycle = providerState.lifecycle;
    this.providerRuntime = providerState.providerRuntime;
    this.providerInitialized = true;
  }

  private async ensureProviderInitialized(): Promise<void> {
    if (this.providerInitialized) {
      return;
    }
    if (this.settings.provider === "none") {
      this.applyProviderResult({
        provider: null,
        requestedProvider: "none",
        providerUnavailableReason: "No embedding provider available (FTS-only mode)",
      });
      this.providerKey = this.computeProviderKey();
      this.batch = this.resolveBatchConfig();
      return;
    }
    if (!this.providerInitPromise) {
      this.providerInitPromise = (async () => {
        const providerResult = await MemoryIndexManager.loadProviderResult({
          cfg: this.cfg,
          agentId: this.agentId,
          settings: this.settings,
          acquireLocalService: this.acquireLocalService,
        });
        this.applyProviderResult(providerResult);
        this.providerKey = this.computeProviderKey();
        this.batch = this.resolveBatchConfig();
      })();
    }
    try {
      await this.providerInitPromise;
    } catch (err) {
      // Clear the cached rejected promise so subsequent calls can retry
      // initialization instead of being permanently stuck with a stale failure.
      this.providerInitPromise = null;
      throw err;
    } finally {
      if (this.providerInitialized) {
        this.providerInitPromise = null;
      }
    }
  }

  protected resetProviderInitializationForRetry(): void {
    this.providerInitialized = false;
    this.providerInitPromise = null;
    this.providerUnavailableReason = undefined;
    this.providerLifecycle = createPendingMemoryProviderLifecycle(this.requestedProvider);
  }

  protected markLocalEmbeddingProviderDegraded(err: unknown): void {
    if (this.provider?.id !== "local") {
      return;
    }
    if (!isLocalEmbeddingWorkerFailure(err)) {
      return;
    }
    const message = formatErrorMessage(err);
    const degradedProvider = this.provider;
    this.provider = null;
    this.providerRuntime = undefined;
    this.providerUnavailableReason = `Local embeddings degraded: ${message}`;
    this.providerLifecycle = createDegradedMemoryProviderLifecycle({
      providerId: degradedProvider.id,
      reason: message,
      code: err.code,
    });
    EMBEDDING_PROBE_CACHE.delete(this.cacheKey);
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    this.vector.semanticAvailable = false;
    void Promise.resolve(degradedProvider.close?.()).catch((errLocal: unknown) => {
      log.debug(`memory embeddings: failed to close degraded local provider: ${String(errLocal)}`);
    });
    log.warn("memory embeddings: local provider degraded after worker failure", {
      error: message,
    });
  }

  protected isRequiredProviderUnavailable(): boolean {
    return this.providerRequirement.mode === "required" && !this.provider;
  }

  protected buildRequiredProviderUnavailableError(operation: "search" | "sync"): Error {
    const registeredProviderIds = listRegisteredMemoryEmbeddingProviderAdapters()
      .map((adapter) => adapter.id)
      .toSorted();
    const registeredProviders =
      registeredProviderIds.length > 0 ? registeredProviderIds.join(",") : "none";
    const reason =
      this.providerUnavailableReason ??
      (this.providerLifecycle.mode === "fts-only"
        ? this.providerLifecycle.reason
        : "provider is unavailable");
    return new Error(
      `Memory ${operation} unavailable: embedding provider "${this.settings.provider}" is configured but unavailable. ` +
        `Reason: ${reason}. ` +
        `agentId=${this.agentId} purpose=${this.purpose} lifecycle=${JSON.stringify(this.providerLifecycle)} ` +
        `registeredMemoryEmbeddingProviders=${registeredProviders}`,
    );
  }

  protected assertRequiredProviderAvailable(operation: "search" | "sync"): void {
    if (this.isRequiredProviderUnavailable()) {
      const error = this.buildRequiredProviderUnavailableError(operation);
      this.resetProviderInitializationForRetry();
      throw error;
    }
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err: unknown) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  private refreshIndexIdentityDirty(params?: { providerKeyKnown?: boolean }) {
    const provider =
      this.settings.provider === "none"
        ? null
        : this.providerInitialized
          ? this.provider
            ? { id: this.provider.id, model: this.provider.model }
            : null
          : undefined;
    const state = this.resolveCurrentIndexIdentityState({
      ...(provider !== undefined ? { provider } : {}),
      providerKeyKnown: params?.providerKeyKnown,
    });
    this.indexIdentityState = state;
    this.indexIdentityDirty =
      state.status === "mismatched" ||
      (state.status === "missing" && (this.sources.has("memory") || this.hasIndexedChunks()));
    return state;
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      /** When set, only these chunk sources are considered (must be enabled for this manager). */
      sources?: MemorySource[];
      /** Caller-owned cancellation; aborts in-flight embedding work when the caller stops waiting. */
      signal?: AbortSignal;
    },
  ): Promise<MemorySearchResult[]> {
    opts?.onDebug?.({ backend: "builtin" });
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }
    if (this.providerRequirement.mode === "required") {
      await this.ensureProviderInitialized();
      this.assertRequiredProviderAvailable("search");
    }
    let hasIndexedContent = this.hasIndexedContent();
    if (!hasIndexedContent) {
      try {
        // A fresh process can receive its first search before background watch/session
        // syncs have built the index. Force one synchronous bootstrap so the first
        // lookup after restart does not fail closed with empty results.
        await this.sync({ reason: "search", force: true });
      } catch (err) {
        log.warn(`memory sync failed (search-bootstrap): ${String(err)}`);
      }
      hasIndexedContent = this.hasIndexedContent();
    }
    const preflight = resolveMemorySearchPreflight({
      query: normalizedQuery,
      hasIndexedContent,
    });
    if (!preflight.shouldSearch) {
      return [];
    }
    const cleaned = preflight.normalizedQuery;
    void this.warmSession(opts?.sessionKey);
    await startAsyncSearchSync({
      enabled: this.settings.sync.onSearch,
      dirty: this.dirty,
      sessionsDirty: this.sessionsDirty,
      sync: async (params) => await this.sync(params),
      onError: (err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      },
    });
    if (preflight.shouldInitializeProvider) {
      await this.ensureProviderInitialized();
      this.assertRequiredProviderAvailable("search");
    }
    if (!this.provider && this.providerLifecycle.mode === "degraded") {
      const activatedFallback = await this.activateFallbackProvider(
        this.providerLifecycle.reason,
      ).catch((fallbackErr: unknown) => {
        log.warn(
          `memory search: failed to activate fallback provider: ${formatErrorMessage(fallbackErr)}`,
        );
        return false;
      });
      if (activatedFallback) {
        this.refreshIndexIdentityDirty({
          providerKeyKnown: this.providerInitialized,
        });
      }
    }
    const indexIdentity = this.refreshIndexIdentityDirty({
      providerKeyKnown: this.providerInitialized,
    });
    if (indexIdentity.status !== "valid") {
      return [];
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const searchSources =
      opts?.sources && opts.sources.length > 0
        ? uniqueValues(opts.sources).filter((s) => this.sources.has(s))
        : undefined;
    if (
      opts?.sources &&
      opts.sources.length > 0 &&
      (!searchSources || searchSources.length === 0)
    ) {
      return [];
    }
    // The manager may index recall-only transcripts without making them part of
    // ordinary searches. Trusted recall passes an explicit source override;
    // every other caller defaults to the configured search corpus.
    const sourceFilterList = searchSources ?? this.settings.searchSources;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    // FTS-only mode: no embedding provider available
    if (!this.provider) {
      this.assertRequiredProviderAvailable("search");
      if (!this.fts.enabled || !this.fts.available) {
        log.warn("memory search: no provider and FTS unavailable");
        return [];
      }

      const keywordResults = await this.searchKeywordWithFallback(
        cleaned,
        candidates,
        {
          boostFallbackRanking: true,
        },
        sourceFilterList,
      ).catch((err: unknown) => {
        log.warn(`memory search: FTS keyword query failed: ${formatErrorMessage(err)}`);
        return [];
      });

      return await this.finalizeKeywordOnlyResults({
        results: keywordResults,
        temporalDecay: hybrid.temporalDecay,
        maxResults,
        minScore,
      });
    }

    // If FTS isn't available, hybrid mode cannot use keyword search; degrade to vector-only.
    const loadKeywordResults = async () =>
      hybrid.enabled && this.fts.enabled && this.fts.available
        ? await this.searchKeywordWithFallback(
            cleaned,
            candidates,
            { boostFallbackRanking: true },
            sourceFilterList,
          ).catch((err: unknown) => {
            log.warn(`memory search: FTS hybrid keyword query failed: ${formatErrorMessage(err)}`);
            return [];
          })
        : [];
    let keywordResults = await loadKeywordResults();

    let queryVec: number[];
    try {
      queryVec = await this.embedQueryWithRetry(cleaned, opts?.signal);
    } catch (err) {
      // An aborted caller already stopped waiting; skip fallback-provider
      // activation so the abandoned search stops instead of re-embedding.
      if (opts?.signal?.aborted) {
        throw err;
      }
      const message = formatErrorMessage(err);
      const activatedFallback = this.shouldFallbackOnError(err)
        ? await this.activateFallbackProvider(message).catch((fallbackErr: unknown) => {
            log.warn(
              `memory search: failed to activate fallback provider: ${formatErrorMessage(fallbackErr)}`,
            );
            return false;
          })
        : false;
      if (activatedFallback) {
        if (
          this.refreshIndexIdentityDirty({
            providerKeyKnown: this.providerInitialized,
          }).status !== "valid"
        ) {
          return [];
        }
        keywordResults = await loadKeywordResults();
        queryVec = await this.embedQueryWithRetry(cleaned, opts?.signal);
      } else if (!this.provider && this.fts.enabled && this.fts.available) {
        log.warn(`memory search: embeddings unavailable; using keyword-only results: ${message}`);
        return await this.finalizeKeywordOnlyResults({
          results: keywordResults,
          temporalDecay: hybrid.temporalDecay,
          maxResults,
          minScore,
        });
      } else {
        throw err;
      }
    }
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates, sourceFilterList).catch((err: unknown) => {
          log.warn(`memory search: vector query failed: ${formatErrorMessage(err)}`);
          return [];
        })
      : [];

    if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const merged = await this.mergeHybridResults({
      query: cleaned,
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
    });
    const strict = merged.filter((entry) => entry.score >= minScore);
    if (strict.length > 0 || keywordResults.length === 0) {
      return strict.slice(0, maxResults);
    }

    // Hybrid defaults can produce keyword-only matches below minScore after
    // BM25 normalization and textWeight scaling. Preserve FTS-backed lexical
    // hits when they are the only relevant results.
    const relaxedMinScore = 0;
    const keywordKeys = new Set(
      keywordResults.map(
        (entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`,
      ),
    );
    return this.selectScoredResults(
      merged.filter((entry) =>
        keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`),
      ),
      maxResults,
      minScore,
      relaxedMinScore,
    );
  }

  private selectScoredResults<T extends MemorySearchResult & { score: number }>(
    results: T[],
    maxResults: number,
    minScore: number,
    relaxedMinScore = minScore,
  ): T[] {
    const strict = results.filter((entry) => entry.score >= minScore);
    if (strict.length > 0) {
      return strict.slice(0, maxResults);
    }
    return results.filter((entry) => entry.score >= relaxedMinScore).slice(0, maxResults);
  }

  private rankKeywordOnlyResults(
    results: KeywordSearchHit[],
    preferExactBody = true,
  ): KeywordSearchHit[] {
    return results
      .toSorted((left, right) => compareKeywordSearchHits(left, right, preferExactBody))
      .map((entry) =>
        entry.exactPathSpecificity > 0 ? Object.assign(entry, { score: 1 }) : entry,
      );
  }

  private async finalizeKeywordOnlyResults(params: {
    results: KeywordSearchHit[];
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
    maxResults: number;
    minScore: number;
  }): Promise<MemorySearchResult[]> {
    const appliesTemporalDecay = params.temporalDecay?.enabled === true;
    const decayInputs = appliesTemporalDecay
      ? params.results.map((entry) => {
          if (entry.exactPathSpecificity === 0) {
            return entry;
          }
          const contentScore = entry.textScore > 0 ? entry.score : 0;
          return { ...entry, score: scoreExactPathTieForTemporalDecay(contentScore) };
        })
      : params.results;
    const decayed = await applyTemporalDecayToHybridResults({
      results: decayInputs,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    });
    const ranked = this.rankKeywordOnlyResults(decayed, !appliesTemporalDecay);
    return this.toMemorySearchResults(
      this.selectScoredResults(ranked, params.maxResults, params.minScore, 0),
    );
  }

  private hasIndexedContent(): boolean {
    const chunkRow = this.db.prepare(`SELECT 1 as found FROM memory_index_chunks LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    if (chunkRow?.found === 1) {
      return true;
    }
    if (!this.fts.enabled || !this.fts.available) {
      return false;
    }
    const ftsRow = this.db.prepare(`SELECT 1 as found FROM ${FTS_TABLE} LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    return ftsRow?.found === 1;
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
    sourceFilterList: MemorySource[],
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    // This method should never be called without a provider
    if (!this.provider) {
      return [];
    }
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      providerModelAliases: this.resolveProviderIndexIdentities()
        .slice(1)
        .map((identity) => identity.model),
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c", sourceFilterList),
      sourceFilterChunks: this.buildSourceFilter(undefined, sourceFilterList),
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
    options?: { boostFallbackRanking?: boolean; exactPathQuery?: string },
    sourceFilterList?: MemorySource[],
  ): Promise<KeywordSearchHit[]> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const bodySearch = searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      query,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter: this.buildSourceFilter(undefined, sourceFilterList),
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
      boostFallbackRanking: options?.boostFallbackRanking,
    }).catch((err: unknown) => {
      log.warn(`memory search: body keyword query failed: ${formatErrorMessage(err)}`);
      return [];
    });
    const exactPathQuery = options?.exactPathQuery ?? query;
    const pathSearch = searchPathKeyword({
      db: this.db,
      pathFtsTable: PATH_FTS_TABLE,
      query,
      exactPathQuery,
      exactPathLimit: EXACT_PATH_CANDIDATE_LIMIT,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter: this.buildSourceFilter(PATH_FTS_TABLE, sourceFilterList),
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
    }).catch((err: unknown) => {
      log.warn(`memory search: path keyword query failed: ${formatErrorMessage(err)}`);
      return [];
    });
    const [bodyResults, pathResults] = await Promise.all([bodySearch, pathSearch]);
    const merged = this.mergeKeywordSearchHits(
      [
        bodyResults.map((entry) =>
          Object.assign(entry, {
            exactPathSpecificity: resolveExactPathSpecificity(exactPathQuery, entry.path),
            pathScore: 0,
          }),
        ),
        pathResults,
      ],
      exactPathQuery,
    );
    return this.limitKeywordSearchHits(merged, limit);
  }

  private async searchKeywordWithFallback(
    query: string,
    limit: number,
    options: { boostFallbackRanking?: boolean } | undefined,
    sourceFilterList: MemorySource[],
  ): Promise<KeywordSearchHit[]> {
    const fullQueryResults = await this.searchKeyword(
      query,
      limit,
      options,
      sourceFilterList,
    ).catch(() => []);
    if (fullQueryResults.length > 0) {
      return fullQueryResults;
    }

    // Broaden recall for conversational queries when the exact AND query is too
    // strict, but cap the number of extra FTS probes so long prompts cannot fan
    // out into unbounded sqlite work.
    const fallbackTerms = this.resolveKeywordFallbackTerms(query);
    if (fallbackTerms.length === 0) {
      return [];
    }

    const resultSets = await Promise.all(
      fallbackTerms.map((term) =>
        this.searchKeyword(
          term,
          limit,
          { ...options, exactPathQuery: query },
          sourceFilterList,
        ).catch(() => []),
      ),
    );
    return this.limitKeywordSearchHits(this.mergeKeywordSearchHits(resultSets, query), limit);
  }

  private resolveKeywordFallbackTerms(query: string): string[] {
    const keywords = extractKeywords(query, {
      ftsTokenizer: this.settings.store.fts.tokenizer,
    }).filter((term) => term !== query);
    return keywords.slice(0, KEYWORD_FALLBACK_SEARCH_TERM_LIMIT);
  }

  private mergeKeywordSearchHits(
    resultSets: KeywordSearchHit[][],
    exactPathQuery?: string,
  ): KeywordSearchHit[] {
    const seenIds = new Map<string, KeywordSearchHit>();
    for (const results of resultSets) {
      for (const result of results) {
        const existing = seenIds.get(result.id);
        if (!existing) {
          seenIds.set(result.id, result);
          continue;
        }
        const existingHasBody = existing.textScore > 0;
        const resultHasBody = result.textScore > 0;
        const existingBodyScore = existingHasBody ? existing.score : 0;
        const resultBodyScore = resultHasBody ? result.score : 0;
        existing.textScore = Math.max(existing.textScore, result.textScore);
        existing.pathScore = Math.max(existing.pathScore, result.pathScore);
        existing.exactPathSpecificity = Math.max(
          existing.exactPathSpecificity,
          result.exactPathSpecificity,
        ) as ExactPathSpecificity;
        const bodyScore = Math.max(existingBodyScore, resultBodyScore);
        existing.score = bodyScore > 0 ? bodyScore : existing.pathScore;
        // Path hits project the first chunk; keep a real body-match snippet
        // authoritative when both retrieval surfaces find the same document.
        if (
          (resultHasBody && !existingHasBody) ||
          (resultHasBody === existingHasBody && result.snippet.length > existing.snippet.length)
        ) {
          existing.snippet = result.snippet;
        }
      }
    }
    const merged = [...seenIds.values()];
    if (exactPathQuery !== undefined) {
      // Fallback terms broaden lexical recall, but only the original user query
      // can claim exact path, basename, or stem precedence.
      for (const result of merged) {
        result.exactPathSpecificity = resolveExactPathSpecificity(exactPathQuery, result.path);
      }
    }
    for (const result of merged) {
      if (result.textScore === 0) {
        // A uniform exact-only baseline lets temporal decay order otherwise
        // equivalent filename hits without reusing incomparable path BM25.
        result.score = result.exactPathSpecificity > 0 ? 1 : result.pathScore;
      }
    }
    return merged.toSorted(compareKeywordSearchHits);
  }

  private limitKeywordSearchHits(
    results: KeywordSearchHit[],
    nonExactLimit: number,
  ): KeywordSearchHit[] {
    const ranked = results.toSorted(compareKeywordSearchHits);
    const exactBody = ranked
      .filter((entry) => entry.exactPathSpecificity > 0 && entry.textScore > 0)
      .slice(0, nonExactLimit);
    const exactPathOnly = ranked.filter(
      (entry) => entry.exactPathSpecificity > 0 && entry.textScore === 0,
    );
    const boundedExact = exactBody.concat(exactPathOnly).toSorted(compareKeywordSearchHits);
    const selectedPathKeys = new Set<string>();
    for (const entry of boundedExact) {
      selectedPathKeys.add(`${entry.source}:${entry.path}`);
      if (selectedPathKeys.size === EXACT_PATH_CANDIDATE_LIMIT) {
        break;
      }
    }
    const exact = boundedExact.filter((entry) =>
      selectedPathKeys.has(`${entry.source}:${entry.path}`),
    );
    const nonExact = ranked
      .filter((entry) => entry.exactPathSpecificity === 0)
      .slice(0, nonExactLimit);
    return exact.concat(nonExact);
  }

  private toMemorySearchResults(results: KeywordSearchHit[]): MemorySearchResult[] {
    return results.map(
      ({
        id: _id,
        pathScore: _pathScore,
        exactPathSpecificity: _exactPathSpecificity,
        ...result
      }) => result,
    );
  }

  private mergeHybridResults(params: {
    query: string;
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<
      MemorySearchResult & {
        id: string;
        textScore: number;
        pathScore: number;
        exactPathSpecificity: ExactPathSpecificity;
      }
    >;
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
  }): Promise<MemorySearchResult[]> {
    return mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
        exactPathSpecificity: resolveExactPathSpecificity(params.query, r.path),
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
        rankingScore: r.score,
        pathScore: r.pathScore,
        exactPathSpecificity: r.exactPathSpecificity,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    }).then((entries) => entries.map((entry) => entry as MemorySearchResult));
  }

  async sync(params?: MemorySyncParams): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.syncing) {
      if (hasTargetedSessionSyncParams(params)) {
        return this.enqueueTargetedSessionSync(params);
      }
      return this.syncing;
    }
    this.syncing = (async () => {
      await this.ensureProviderInitialized();
      await this.runSyncWithReadonlyRecovery(params);
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  private enqueueTargetedSessionSync(
    targets?: Pick<MemorySyncParams, "sessions" | "archiveFiles">,
  ): Promise<void> {
    return enqueueMemoryTargetedSessionSync(
      {
        isClosed: () => this.closed,
        getSyncing: () => this.syncing,
        getQueuedArchiveFiles: () => this.queuedArchiveFiles,
        getQueuedSessions: () => this.queuedSessions,
        getQueuedSessionSync: () => this.queuedSessionSync,
        setQueuedSessionSync: (value) => {
          this.queuedSessionSync = value;
        },
        sync: async (params) => await this.sync(params),
      },
      targets,
    );
  }

  private async runSyncWithReadonlyRecovery(params?: MemorySyncParams): Promise<void> {
    const getClosed = () => this.closed;
    const getDb = () => this.db;
    const setDb = (value: DatabaseSync) => {
      this.db = value;
    };
    const getReadonlyRecoveryAttempts = () => this.readonlyRecoveryAttempts;
    const setReadonlyRecoveryAttempts = (value: number) => {
      this.readonlyRecoveryAttempts = value;
    };
    const getReadonlyRecoverySuccesses = () => this.readonlyRecoverySuccesses;
    const setReadonlyRecoverySuccesses = (value: number) => {
      this.readonlyRecoverySuccesses = value;
    };
    const getReadonlyRecoveryFailures = () => this.readonlyRecoveryFailures;
    const setReadonlyRecoveryFailures = (value: number) => {
      this.readonlyRecoveryFailures = value;
    };
    const getReadonlyRecoveryLastError = () => this.readonlyRecoveryLastError;
    const setReadonlyRecoveryLastError = (value: string | undefined) => {
      this.readonlyRecoveryLastError = value;
    };
    const state: MemoryReadonlyRecoveryState = {
      get closed() {
        return getClosed();
      },
      get db() {
        return getDb();
      },
      set db(value) {
        setDb(value);
      },
      vector: this.vector,
      get readonlyRecoveryAttempts() {
        return getReadonlyRecoveryAttempts();
      },
      set readonlyRecoveryAttempts(value) {
        setReadonlyRecoveryAttempts(value);
      },
      get readonlyRecoverySuccesses() {
        return getReadonlyRecoverySuccesses();
      },
      set readonlyRecoverySuccesses(value) {
        setReadonlyRecoverySuccesses(value);
      },
      get readonlyRecoveryFailures() {
        return getReadonlyRecoveryFailures();
      },
      set readonlyRecoveryFailures(value) {
        setReadonlyRecoveryFailures(value);
      },
      get readonlyRecoveryLastError() {
        return getReadonlyRecoveryLastError();
      },
      set readonlyRecoveryLastError(value) {
        setReadonlyRecoveryLastError(value);
      },
      runSync: (nextParams) => this.runSync(nextParams),
      openDatabase: () => this.openDatabase(),
      closeDatabase: (db) => closeMemoryDatabase(db),
      resetVectorState: () => this.resetVectorState(),
      ensureSchema: () => this.ensureSchema(),
      readMeta: () => this.readMeta() ?? undefined,
    };
    await runMemorySyncWithReadonlyRecovery(state, params);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    return await readMemoryFile({
      workspaceDir: this.workspaceDir,
      extraPaths: this.settings.extraPaths,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    });
  }

  status(): MemoryProviderStatus {
    this.refreshIndexIdentityDirty({
      providerKeyKnown: this.providerInitialized,
    });
    const sourceFilter = this.buildSourceFilter();
    const aggregateState = collectMemoryStatusAggregate({
      db: {
        prepare: (sql) => ({
          all: (...args) =>
            this.db.prepare(sql).all(...args) as Array<{
              kind: "files" | "chunks";
              source: MemorySource;
              c: number;
            }>,
        }),
      },
      sources: this.sources,
      sourceFilterSql: sourceFilter.sql,
      sourceFilterParams: sourceFilter.params,
    });

    const providerInfo = resolveStatusProviderInfo({
      provider: this.provider,
      providerInitialized: this.providerInitialized,
      requestedProvider: this.requestedProvider,
      configuredModel: this.settings.model || undefined,
    });

    return {
      backend: "builtin",
      files: aggregateState.files,
      chunks: aggregateState.chunks,
      dirty: this.dirty || this.sessionsDirty || this.indexIdentityDirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.databasePath,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts: aggregateState.sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        storeAvailable: this.vector.available ?? undefined,
        semanticAvailable: this.vector.semanticAvailable,
        available: this.vector.semanticAvailable,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        limit: MEMORY_BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      },
      custom: {
        llamaCppRuntime: getLocalEmbeddingRuntimeFacts(this.provider),
        searchMode: providerInfo.searchMode,
        providerState: this.providerLifecycle,
        providerUnavailableReason: this.providerUnavailableReason,
        indexIdentity: this.indexIdentityState,
        readonlyRecovery: {
          attempts: this.readonlyRecoveryAttempts,
          successes: this.readonlyRecoverySuccesses,
          failures: this.readonlyRecoveryFailures,
          lastError: this.readonlyRecoveryLastError,
        },
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      this.vector.semanticAvailable = false;
      return false;
    }
    await this.ensureProviderInitialized();
    // FTS-only mode: vector search not available
    if (!this.provider) {
      this.vector.semanticAvailable = false;
      return false;
    }
    const ready = await this.probeVectorStoreAvailability();
    this.vector.semanticAvailable = ready;
    return ready;
  }

  async probeVectorStoreAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    return await this.ensureVectorReady();
  }

  private cacheProbeResult(result: MemoryEmbeddingProbeResult): MemoryEmbeddingProbeResult {
    const checkedAtMs = Date.now();
    EMBEDDING_PROBE_CACHE.set(this.cacheKey, {
      result,
      checkedAtMs,
      expireAtMs: checkedAtMs + EMBEDDING_PROBE_CACHE_TTL_MS,
    });
    return result;
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    const cached = EMBEDDING_PROBE_CACHE.get(this.cacheKey);
    if (!cached) {
      return null;
    }
    const nowMs = Date.now();
    if (nowMs >= cached.expireAtMs) {
      EMBEDDING_PROBE_CACHE.delete(this.cacheKey);
      return null;
    }
    return {
      ...cached.result,
      checked: true,
      cached: true,
      checkedAtMs: cached.checkedAtMs,
      cacheExpiresAtMs: cached.expireAtMs,
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const cached = this.getCachedEmbeddingAvailability();
    if (cached) {
      return cached;
    }
    await this.ensureProviderInitialized();
    // FTS-only mode: embeddings not available but search still works
    if (!this.provider) {
      return this.cacheProbeResult({
        ok: false,
        error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
      });
    }
    try {
      await this.embedBatchWithRetry(["ping"]);
      return this.cacheProbeResult({ ok: true });
    } catch (err) {
      const message = formatErrorMessage(err);
      return this.cacheProbeResult({ ok: false, error: message });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const pendingProviderInit = this.providerInitPromise;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.memoryWatchPressureStartupTimer) {
      clearTimeout(this.memoryWatchPressureStartupTimer);
      this.memoryWatchPressureStartupTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.closeNativeMemoryWatchPairs();
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    const closeErrors = new Map<EmbeddingProvider, unknown>();
    // Sync/provider fallback may swap this.provider while close is awaiting.
    // Keep every observed provider and drain the set after sync has settled.
    const providersToClose = new Set<EmbeddingProvider>();
    const rememberCurrentProvider = () => {
      const provider = this.provider;
      if (!provider) {
        return;
      }
      providersToClose.add(provider);
    };
    const closeProvider = async (provider: EmbeddingProvider) => {
      try {
        await provider.close?.();
        closeErrors.delete(provider);
        if (this.provider === provider) {
          this.provider = null;
        }
      } catch (err) {
        closeErrors.set(provider, err);
        providersToClose.add(provider);
      } finally {
        rememberCurrentProvider();
      }
    };
    const drainTrackedProviders = async () => {
      for (let attempt = 0; attempt < 2 && providersToClose.size > 0; attempt += 1) {
        const providers = Array.from(providersToClose);
        providersToClose.clear();
        try {
          for (const provider of providers) {
            await closeProvider(provider);
          }
        } finally {
          rememberCurrentProvider();
        }
      }
    };
    const reportPendingWorkError = (err: unknown) => {
      log.warn(`memory close: pending manager work failed: ${formatErrorMessage(err)}`);
    };
    const awaitCurrentSync = async () => {
      const pendingSync = this.syncing;
      if (!pendingSync) {
        return;
      }
      await awaitPendingManagerWork({
        pendingSync,
        onError: reportPendingWorkError,
      });
    };
    await awaitPendingManagerWork({
      pendingProviderInit,
      onError: reportPendingWorkError,
    });
    rememberCurrentProvider();
    try {
      await awaitCurrentSync();
      rememberCurrentProvider();
      await drainTrackedProviders();
    } finally {
      closeMemoryDatabase(this.db);
      if (INDEX_CACHE.get(this.cacheKey) === this) {
        INDEX_CACHE.delete(this.cacheKey);
      }
    }
    const closeError = closeErrors.values().next().value;
    if (closeError) {
      throw toLintErrorObject(closeError, "Non-Error thrown");
    }
  }
}

function hasTargetedSessionSyncParams(params: MemorySyncParams | undefined): boolean {
  return Boolean(
    params?.sessions?.some((session) => session.sessionId.trim().length > 0) ||
    params?.archiveFiles?.some((sessionFile) => sessionFile.trim().length > 0),
  );
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
