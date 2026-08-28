// Memory Core plugin module implements the concrete memory index manager.
import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  readMemoryFile,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  type MemoryProviderStatus,
  type MemoryReadResult,
  type MemorySearchManager,
  type MemorySessionSyncTarget,
  type MemorySource,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";
import type { EmbeddingProvider, EmbeddingProviderRequest } from "./embeddings.js";
import { awaitPendingManagerWork } from "./manager-async-state.js";
import { MEMORY_BATCH_FAILURE_LIMIT } from "./manager-batch-state.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { closeMemoryDatabase } from "./manager-db.js";
import {
  clearMemoryEmbeddingProbeCache,
  resolveEffectiveMemorySearchSettings,
  resolveMemoryEmbeddingProviderRequirement,
  type MemoryEmbeddingBootstrapDebug,
  type MemoryEmbeddingProviderRequirement,
} from "./manager-provider-lifecycle.js";
import {
  createPendingMemoryProviderLifecycle,
  type MemoryProviderLifecycleState,
} from "./manager-provider-state.js";
import {
  MemoryManagerRegistry,
  resolveMemoryIndexManagerCacheKey,
  type MemoryIndexManagerPurpose,
} from "./manager-registry.js";
import type { MemoryIndexIdentityState } from "./manager-reindex-state.js";
import { MemorySearchOrchestration } from "./manager-search-orchestration.js";
import {
  collectMemoryStatusAggregate,
  resolveInitialMemoryDirty,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";
import { enqueueMemoryTargetedSessionSync } from "./manager-sync-control.js";
import { resolvePersistedMemoryVectorIndexState } from "./manager-vector-rebuild-state.js";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

function getLocalEmbeddingRuntimeFacts(provider: EmbeddingProvider | null): unknown {
  if (!provider) {
    return undefined;
  }
  const getRuntimeFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
  return typeof getRuntimeFacts === "function" ? getRuntimeFacts() : undefined;
}

const log = createSubsystemLogger("memory");
const INDEX_MANAGER_REGISTRY = new MemoryManagerRegistry<MemoryIndexManager>();

export async function closeAllMemoryIndexManagers(): Promise<void> {
  clearMemoryEmbeddingProbeCache();
  await INDEX_MANAGER_REGISTRY.closeAll(async (manager) => await manager.close());
}

export async function closeMemoryIndexManagersForAgent(params: { agentId: string }): Promise<void> {
  await INDEX_MANAGER_REGISTRY.closeForAgent({
    agentId: params.agentId,
    purpose: "default",
    close: async (manager) => await manager.close(),
  });
}

export class MemoryIndexManager extends MemorySearchOrchestration implements MemorySearchManager {
  protected readonly cacheKey: string;
  protected readonly purpose: MemoryIndexManagerPurpose;
  protected override readonly acquireLocalService?: MemoryCoreAcquireLocalService;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected readonly providerRequirement: MemoryEmbeddingProviderRequirement;
  protected readonly requestedProvider: EmbeddingProviderRequest;
  protected providerInitPromise: Promise<void> | null = null;
  protected providerInitialized = false;
  protected embeddingBootstrapFailure?: MemoryEmbeddingBootstrapDebug;
  protected providerRetirementPromise: Promise<void> = Promise.resolve();
  protected providersPendingRetirement = new Set<EmbeddingProvider>();
  private closePromise: Promise<void> | null = null;
  private closeTeardownComplete = false;
  protected closing = false;
  protected activeManagerOperations = 0;
  protected managerIdleWaiters = new Set<() => void>();
  protected providerUnavailableReason?: string;
  protected override providerLifecycle: MemoryProviderLifecycleState;
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
  protected publishedDatabase: MemoryIndexDatabase;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  protected indexIdentityDirty = false;
  protected sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;
  private queuedArchiveFiles = new Set<string>();
  private queuedSessions = new Map<string, MemorySessionSyncTarget>();
  private queuedForce = false;
  private queuedProgressCallbacks = new Set<NonNullable<MemorySyncParams["progress"]>>();
  private queuedSessionSync: Promise<void> | null = null;
  protected indexIdentityState: MemoryIndexIdentityState = {
    status: "missing",
    reason: "index metadata is missing",
  };

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: MemoryIndexManagerPurpose;
    inspectSources?: boolean;
    acquireLocalService?: MemoryCoreAcquireLocalService;
  }): Promise<MemoryIndexManager | null> {
    const agentId = normalizeAgentId(params.agentId);
    const purpose =
      params.purpose === "status" || params.purpose === "cli" ? params.purpose : "default";
    return await INDEX_MANAGER_REGISTRY.acquire(
      { agentId, purpose },
      {
        prepare: () => {
          const settings = resolveMemorySearchConfig(params.cfg, agentId);
          if (!settings) {
            return null;
          }
          const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
          const providerRequirement = resolveMemoryEmbeddingProviderRequirement({
            cfg: params.cfg,
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
          return {
            key,
            transient: purpose === "status" || purpose === "cli",
            create: async () => {
              const manager = new MemoryIndexManager({
                cacheKey: key,
                cfg: params.cfg,
                agentId,
                workspaceDir,
                settings,
                providerRequirement,
                purpose: params.purpose,
                acquireLocalService: params.acquireLocalService,
              });
              if (params.inspectSources) {
                await manager.inspectDiagnosticSourceState();
              }
              return manager;
            },
            reuse: (manager) => !manager.closing && !manager.closed,
          };
        },
        close: async (manager) => await manager.close(),
      },
    );
  }

  private constructor(params: {
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerRequirement: MemoryEmbeddingProviderRequirement;
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
    this.requestedProvider = effectiveSettings.provider;
    this.providerLifecycle = createPendingMemoryProviderLifecycle(this.requestedProvider);
    for (const source of effectiveSettings.sources) {
      this.sources.add(source);
    }
    this.publishedDatabase = new MemoryIndexDatabase(this.openDatabase());
    try {
      this.providerKey = this.computeProviderKey();
      this.cache = {
        enabled: effectiveSettings.cache.enabled,
        maxEntries: effectiveSettings.cache.maxEntries,
      };
      this.fts.enabled = effectiveSettings.query.hybrid.enabled;
      this.ensureSchema();
      this.vector.enabled = effectiveSettings.store.vector.enabled;
      this.vector.extensionPath = effectiveSettings.store.vector.extensionPath;
      const meta = this.readMeta();
      if (meta?.vectorDims) {
        this.vector.dims = meta.vectorDims;
      }
      const initialIndexIdentity = this.resolveCurrentIndexIdentityState({
        meta,
        providerKeyKnown: false,
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
      const invalidatedSources = new Set(
        (
          this.db
            .prepare("SELECT DISTINCT source FROM memory_index_sources WHERE hash = ''")
            .all() as Array<{ source?: unknown }>
        ).flatMap((row) =>
          row.source === "memory" || row.source === "sessions" ? [row.source] : [],
        ),
      );
      this.memorySourceProvenanceRepairPending =
        this.sources.has("memory") && invalidatedSources.has("memory");
      this.dirty =
        resolveInitialMemoryDirty({
          hasMemorySource: this.sources.has("memory"),
          statusOnly: params.purpose === "status",
          hasIndexedMeta: Boolean(meta),
        }) || this.memorySourceProvenanceRepairPending;
      if (this.sources.has("sessions") && invalidatedSources.has("sessions")) {
        // Migration cannot map a durable session source path back to one live
        // transcript file. Carry a full-session retry so unchanged and deleted
        // transcripts both converge on the next startup/search sync.
        this.sessionsDirty = true;
        this.sessionsFullRetryDirty = true;
      }
      this.batch = this.resolveBatchConfig();
      if (!transient) {
        this.ensureSessionStartupCatchup();
      }
    } catch (err) {
      closeMemoryDatabase(this.db);
      throw err;
    }
  }

  async sync(params?: MemorySyncParams): Promise<void> {
    return await this.withPublishedDatabase(() => this.syncPublished(params));
  }

  private async syncPublished(params?: MemorySyncParams): Promise<void> {
    if (this.closing || this.closed) {
      return;
    }
    if (
      hasTargetedSessionSyncParams(params) &&
      (this.queuedSessionSync !== null ||
        this.queuedArchiveFiles.size > 0 ||
        this.queuedSessions.size > 0)
    ) {
      // A failed queued batch stays manager-owned. Route the next targeted
      // call through the queue even while idle so it adopts that retained work.
      return await this.enqueueTargetedSessionSync(params);
    }
    return await this.syncAdmitted(params);
  }

  protected async syncAdmitted(
    params?: MemorySyncParams,
    options?: {
      allowEmbeddingBootstrapFallback?: boolean;
      queuedSessionOwner?: boolean;
    },
  ): Promise<void> {
    if (this.syncing) {
      if (hasTargetedSessionSyncParams(params)) {
        if (options?.queuedSessionOwner) {
          // Another caller claimed the sync slot after this queue owner was
          // created. Wait for it, then retry admission instead of enqueueing
          // into the promise that is already awaiting this call.
          await this.syncing.catch(() => undefined);
          if (this.closing || this.closed) {
            return;
          }
          return await this.syncAdmitted(params, options);
        }
        return this.enqueueTargetedSessionSync(params);
      }
      try {
        return await this.syncing;
      } catch (err) {
        if (
          options?.allowEmbeddingBootstrapFallback &&
          this.providerRequirement.mode === "optional" &&
          (!this.providerInitialized || this.embeddingBootstrapFailure !== undefined)
        ) {
          if (!this.embeddingBootstrapFailure) {
            this.markEmbeddingBootstrapFailure(err);
          }
          return await this.syncAdmitted(params, options);
        }
        throw err;
      }
    }
    this.syncing = (async () => {
      const hadBootstrapFailure = this.embeddingBootstrapFailure !== undefined;
      let forceFtsOnly =
        this.embeddingBootstrapFailure !== undefined &&
        this.getCachedEmbeddingAvailability()?.ok === false;
      if (!forceFtsOnly) {
        try {
          await this.ensureProviderInitialized();
        } catch (err) {
          if (
            this.providerRequirement.mode !== "optional" ||
            (!options?.allowEmbeddingBootstrapFallback && !hadBootstrapFailure)
          ) {
            throw err;
          }
          this.markEmbeddingBootstrapFailure(err);
          forceFtsOnly = true;
        }
        if (hadBootstrapFailure && !this.provider) {
          const failure = this.embeddingBootstrapFailure!;
          const nextFailure: MemoryEmbeddingBootstrapDebug = {
            ...failure,
            reason: this.providerUnavailableReason ?? failure.reason,
          };
          this.embeddingBootstrapFailure = nextFailure;
          this.cacheProbeResult({ ok: false, error: nextFailure.reason });
          forceFtsOnly = true;
        }
      }

      const runGeneration = async (keywordOnly: boolean) => {
        this.beginSyncProviderGeneration({ forceFtsOnly: keywordOnly });
        try {
          await this.runSync(params);
        } finally {
          this.endSyncProviderGeneration();
        }
      };
      try {
        await runGeneration(forceFtsOnly);
      } catch (err) {
        const canDegrade =
          this.providerRequirement.mode === "optional" &&
          (options?.allowEmbeddingBootstrapFallback || hadBootstrapFailure) &&
          this.shouldFallbackOnError(err);
        if (!canDegrade) {
          throw err;
        }
        const failedProvider = this.provider?.id ?? this.settings.provider;
        this.markEmbeddingBootstrapFailure(err, {
          retainProvider: this.provider !== null,
          provider: failedProvider,
        });
        forceFtsOnly = true;
        await runGeneration(true);
      }

      if (
        hadBootstrapFailure &&
        !forceFtsOnly &&
        this.provider &&
        this.refreshIndexIdentityDirty({ providerKeyKnown: true }).status === "valid" &&
        (await this.confirmEmbeddingBootstrapRecovery())
      ) {
        this.clearEmbeddingBootstrapFailureAfterRecovery();
      }
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  private enqueueTargetedSessionSync(
    targets?: Pick<MemorySyncParams, "sessions" | "archiveFiles" | "force" | "progress">,
  ): Promise<void> {
    return enqueueMemoryTargetedSessionSync(
      {
        isClosed: () => this.closing || this.closed,
        getSyncing: () => this.syncing,
        getQueuedArchiveFiles: () => this.queuedArchiveFiles,
        getQueuedSessions: () => this.queuedSessions,
        getQueuedForce: () => this.queuedForce,
        setQueuedForce: (value) => {
          this.queuedForce = value;
        },
        getQueuedProgressCallbacks: () => this.queuedProgressCallbacks,
        getQueuedSessionSync: () => this.queuedSessionSync,
        setQueuedSessionSync: (value) => {
          this.queuedSessionSync = value;
        },
        sync: async (params) => await this.syncAdmitted(params, { queuedSessionOwner: true }),
      },
      targets,
    );
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult> {
    return await readMemoryFile({
      workspaceDir: this.workspaceDir,
      extraPaths: this.settings.extraPaths,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    });
  }

  status(): MemoryProviderStatus {
    return this.withPublishedDatabase(() => this.publishedStatus());
  }

  private publishedStatus(): MemoryProviderStatus {
    if (this.embeddingBootstrapFailure) {
      this.refreshKeywordFallbackIndexIdentity();
    } else {
      this.refreshIndexIdentityDirty({
        providerKeyKnown: this.providerInitialized,
      });
    }
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

    // Status projects the effective keyword-only search mode while degraded.
    // Sync generations still snapshot this.provider so recovery can rebuild vectors.
    const statusProvider = this.embeddingBootstrapFailure ? null : this.provider;
    const providerInfo = resolveStatusProviderInfo({
      provider: statusProvider,
      providerInitialized: this.embeddingBootstrapFailure ? true : this.providerInitialized,
      requestedProvider: this.requestedProvider,
      configuredModel: this.settings.model || undefined,
    });
    const pendingSyncSources: MemorySource[] = [];
    if (this.syncing) {
      if (this.dirty) {
        pendingSyncSources.push("memory");
      }
      if (this.sessionsDirty) {
        pendingSyncSources.push("sessions");
      }
    }

    return {
      backend: "builtin",
      files: aggregateState.files,
      chunks: aggregateState.chunks,
      dirty: this.dirty || this.sessionsDirty || this.indexIdentityDirty,
      pendingSyncSources: pendingSyncSources.length > 0 ? pendingSyncSources : undefined,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.databasePath,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts: aggregateState.sourceCounts.map((entry) =>
        Object.assign(entry, this.sourceInspections.get(entry.source) ?? {}),
      ),
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db
                  .prepare(`SELECT COUNT(*) as c FROM ${MEMORY_EMBEDDING_CACHE_TABLE}`)
                  .get() as { c: number } | undefined
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
        index: resolvePersistedMemoryVectorIndexState({
          db: this.db,
          vectorTable: MEMORY_INDEX_VECTOR_TABLE,
          metaVectorDims: this.vector.dims,
          hasSemanticChunks: this.hasSemanticChunks(),
        }),
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
      },
    };
  }

  async close(): Promise<void> {
    const existingClose = this.closePromise;
    if (existingClose) {
      await existingClose;
      return;
    }
    const closeOperation = this.withPublishedDatabase(() =>
      this.closeTeardownComplete ? this.retryFailedClose() : this.closeOnce(),
    );
    this.closePromise = closeOperation;
    try {
      await closeOperation;
    } catch (err) {
      if (this.closePromise === closeOperation) {
        this.closePromise = null;
      }
      throw err;
    }
  }

  private async retryFailedClose(): Promise<void> {
    const retirementErrors = await this.drainPendingProviderRetirements();
    if (this.providersPendingRetirement.size > 0) {
      throw toErrorObject(retirementErrors.at(-1), "Embedding provider retirement failed");
    }
    INDEX_MANAGER_REGISTRY.deleteIfCurrent(this.cacheKey, this);
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    this.queuedArchiveFiles.clear();
    this.queuedSessions.clear();
    this.queuedForce = false;
    this.queuedProgressCallbacks.clear();
    await this.awaitManagerIdle();
    this.closed = true;
    const pendingProviderInit = this.providerInitPromise;
    const pendingFallbackInit = this.getPendingFallbackProviderInitialization();
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
    await awaitPendingManagerWork({
      pendingProviderInit: pendingFallbackInit?.then(() => undefined),
      onError: reportPendingWorkError,
    });
    await awaitCurrentSync();
    const retirementErrors = await this.drainPendingProviderRetirements();
    rememberCurrentProvider();
    try {
      rememberCurrentProvider();
      await drainTrackedProviders();
    } finally {
      closeMemoryDatabase(this.db);
      this.closeTeardownComplete = true;
    }
    const closeError =
      (this.providersPendingRetirement.size > 0 ? retirementErrors.at(-1) : undefined) ??
      closeErrors.values().next().value;
    if (closeError) {
      throw toErrorObject(closeError, "Non-Error thrown");
    }
    INDEX_MANAGER_REGISTRY.deleteIfCurrent(this.cacheKey, this);
  }
}

function hasTargetedSessionSyncParams(params: MemorySyncParams | undefined): boolean {
  return Boolean(
    params?.sessions?.some((session) => session.sessionId.trim().length > 0) ||
    params?.archiveFiles?.some((sessionFile) => sessionFile.trim().length > 0),
  );
}
