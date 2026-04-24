import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentContextLimits,
  resolveAgentWorkspaceDir,
  resolveGlobalSingleton,
  resolveMemorySearchSyncConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { checkQmdBinaryAvailability } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  resolveMemoryBackendConfig,
  type MemoryEmbeddingProbeResult,
  type MemorySearchManager,
  type MemorySearchRuntimeDebug,
  type MemorySyncProgressUpdate,
  type ResolvedQmdConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";

const MEMORY_SEARCH_MANAGER_CACHE_KEY = Symbol.for("openclaw.memorySearchManagerCache");
type Maybe<T> = T | null;
type QmdManagerRuntimeConfig = {
  workspaceDir: string;
  syncSettings: ReturnType<typeof resolveMemorySearchSyncConfig>;
  contextLimits: ReturnType<typeof resolveAgentContextLimits>;
};

type CachedQmdManagerEntry = {
  identityKey: string;
  manager: MemorySearchManager;
};

type PendingQmdManagerCreate = {
  identityKey: string;
  promise: Promise<Maybe<MemorySearchManager>>;
};

type MemorySearchManagerCacheStore = {
  qmdManagerCache: Map<string, CachedQmdManagerEntry>;
  pendingQmdManagerCreates: Map<string, PendingQmdManagerCreate>;
};

function createMemorySearchManagerCacheStore(): MemorySearchManagerCacheStore {
  return {
    qmdManagerCache: new Map<string, CachedQmdManagerEntry>(),
    pendingQmdManagerCreates: new Map<string, PendingQmdManagerCreate>(),
  };
}

function getMemorySearchManagerCacheStore(): MemorySearchManagerCacheStore {
  // Keep caches reachable across `vi.resetModules()` so later cleanup can close older instances.
  const resolved = resolveGlobalSingleton<unknown>(
    MEMORY_SEARCH_MANAGER_CACHE_KEY,
    createMemorySearchManagerCacheStore,
  );
  if (
    typeof resolved === "object" &&
    resolved !== null &&
    (resolved as Partial<MemorySearchManagerCacheStore>).qmdManagerCache instanceof Map &&
    (resolved as Partial<MemorySearchManagerCacheStore>).pendingQmdManagerCreates instanceof Map
  ) {
    return resolved as MemorySearchManagerCacheStore;
  }
  const repaired = createMemorySearchManagerCacheStore();
  (globalThis as Record<PropertyKey, unknown>)[MEMORY_SEARCH_MANAGER_CACHE_KEY] = repaired;
  return repaired;
}

const log = createSubsystemLogger("memory");
const {
  qmdManagerCache: QMD_MANAGER_CACHE,
  pendingQmdManagerCreates: PENDING_QMD_MANAGER_CREATES,
} = getMemorySearchManagerCacheStore();
let managerRuntimePromise: Promise<typeof import("../../manager-runtime.js")> | null = null;
let qmdManagerModulePromise: Promise<typeof import("./qmd-manager.js")> | null = null;

function loadManagerRuntime() {
  managerRuntimePromise ??= import("../../manager-runtime.js");
  return managerRuntimePromise;
}

function loadQmdManagerModule() {
  qmdManagerModulePromise ??= import("./qmd-manager.js");
  return qmdManagerModulePromise;
}

export type MemorySearchManagerResult = {
  manager: Maybe<MemorySearchManager>;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "qmd" && resolved.qmd) {
    const qmdResolved = resolved.qmd;
    const normalizedAgentId = normalizeAgentId(params.agentId);
    const runtimeConfig = resolveQmdManagerRuntimeConfig(params.cfg, normalizedAgentId);
    const { workspaceDir } = runtimeConfig;
    const statusOnly = params.purpose === "status";
    const scopeKey = buildQmdManagerScopeKey(normalizedAgentId);
    const identityKey = buildQmdManagerIdentityKey(normalizedAgentId, qmdResolved, runtimeConfig);

    const createPrimaryQmdManager = async (
      mode: "full" | "status",
    ): Promise<Maybe<MemorySearchManager>> => {
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
      } catch (err) {
        log.warn(
          `qmd workspace unavailable (${workspaceDir}); falling back to builtin: ${formatErrorMessage(err)}`,
        );
        return null;
      }

      const qmdBinary = await checkQmdBinaryAvailability({
        command: qmdResolved.command,
        env: process.env,
        cwd: workspaceDir,
      });
      if (!qmdBinary.available) {
        log.warn(
          `qmd binary unavailable (${qmdResolved.command}); falling back to builtin: ${qmdBinary.error ?? "unknown error"}`,
        );
        return null;
      }
      try {
        const { QmdMemoryManager } = await loadQmdManagerModule();
        const primary = await QmdMemoryManager.create({
          cfg: params.cfg,
          agentId: normalizedAgentId,
          resolved: { ...resolved, qmd: qmdResolved },
          mode,
          runtimeConfig,
        });
        if (primary) {
          return primary;
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
      }
      return null;
    };

    const createFullQmdManager = async (
      expectedIdentityKey: string,
    ): Promise<Maybe<CachedQmdManagerEntry>> => {
      const primary = await createPrimaryQmdManager("full");
      if (!primary) {
        return null;
      }
      let cacheEntry!: CachedQmdManagerEntry;
      const wrapper = new FallbackMemoryManager(
        {
          primary,
          fallbackFactory: async () => {
            const { MemoryIndexManager } = await loadManagerRuntime();
            return await MemoryIndexManager.get(params);
          },
        },
        () => {
          const current = QMD_MANAGER_CACHE.get(scopeKey);
          if (current === cacheEntry) {
            QMD_MANAGER_CACHE.delete(scopeKey);
          }
        },
      );
      cacheEntry = {
        identityKey: expectedIdentityKey,
        manager: wrapper,
      };
      return cacheEntry;
    };

    while (true) {
      const cached = QMD_MANAGER_CACHE.get(scopeKey);
      const cachedMatchesIdentity = cached?.identityKey === identityKey;
      if (cachedMatchesIdentity) {
        if (statusOnly) {
          // Status callers often close the manager they receive. Wrap the live
          // full manager with a no-op close so health/status probes do not tear
          // down the active QMD manager for the process.
          return { manager: new BorrowedMemoryManager(cached.manager) };
        }
        return { manager: cached.manager };
      }

      if (statusOnly) {
        const manager = await createPrimaryQmdManager("status");
        return manager ? { manager } : await getBuiltinMemorySearchManager(params);
      }

      const pending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
      if (pending) {
        await pending.promise;
        continue;
      }

      const pendingCreate: PendingQmdManagerCreate = {
        identityKey,
        promise: (async () => {
          const created = await createFullQmdManager(identityKey);
          if (!created) {
            return null;
          }
          QMD_MANAGER_CACHE.set(scopeKey, created);
          if (cached) {
            await closeQmdManagerForReplacement(cached.manager).catch((err) => {
              log.warn(`failed to retire replaced qmd memory manager: ${formatErrorMessage(err)}`);
            });
          }
          return created.manager;
        })().finally(() => {
          const currentPending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
          if (currentPending === pendingCreate) {
            PENDING_QMD_MANAGER_CREATES.delete(scopeKey);
          }
        }),
      };
      PENDING_QMD_MANAGER_CREATES.set(scopeKey, pendingCreate);
      const manager = await pendingCreate.promise;
      return manager ? { manager } : await getBuiltinMemorySearchManager(params);
    }
  }

  return await getBuiltinMemorySearchManager(params);
}

async function getBuiltinMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  try {
    const { MemoryIndexManager } = await loadManagerRuntime();
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = formatErrorMessage(err);
    return { manager: null, error: message };
  }
}

class BorrowedMemoryManager implements MemorySearchManager {
  constructor(private readonly inner: MemorySearchManager) {}

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
    },
  ) {
    return await this.inner.search(query, opts);
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    return await this.inner.readFile(params);
  }

  status() {
    return this.inner.status();
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    await this.inner.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return await this.inner.probeEmbeddingAvailability();
  }

  async probeVectorAvailability() {
    return await this.inner.probeVectorAvailability();
  }

  async close() {}
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  const pendingCreates = Array.from(PENDING_QMD_MANAGER_CREATES.values(), (entry) => entry.promise);
  await Promise.allSettled(pendingCreates);
  const managers = Array.from(QMD_MANAGER_CACHE.values(), (entry) => entry.manager);
  PENDING_QMD_MANAGER_CREATES.clear();
  QMD_MANAGER_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close qmd memory manager: ${String(err)}`);
    }
  }
  if (managerRuntimePromise !== null) {
    const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
    await closeAllMemoryIndexManagers();
  }
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: Maybe<MemorySearchManager> = null;
  private primaryFailed = false;
  private lastError?: string;
  private cacheEvicted = false;
  private closed = false;
  private closeReason = "memory search manager is closed";

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      fallbackFactory: () => Promise<Maybe<MemorySearchManager>>;
    },
    private readonly onClose?: () => void,
  ) {}

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
    },
  ) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      try {
        return await this.deps.primary.search(query, opts);
      } catch (err) {
        this.primaryFailed = true;
        this.lastError = formatErrorMessage(err);
        log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
        await this.deps.primary.close?.().catch(() => {});
        // Evict the failed wrapper so the next request can retry QMD with a fresh manager.
        this.evictCacheEntry();
      }
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.search(query, opts);
    }
    throw new Error(this.lastError ?? "memory search unavailable");
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.readFile(params);
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.readFile(params);
    }
    throw new Error(this.lastError ?? "memory read unavailable");
  }

  status() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return this.deps.primary.status();
    }
    const fallbackStatus = this.fallback?.status();
    const fallbackInfo = { from: "qmd", reason: this.lastError ?? "unknown" };
    if (fallbackStatus) {
      const custom = fallbackStatus.custom ?? {};
      return {
        ...fallbackStatus,
        fallback: fallbackInfo,
        custom: {
          ...custom,
          fallback: { disabled: true, reason: this.lastError ?? "unknown" },
        },
      };
    }
    const primaryStatus = this.deps.primary.status();
    const custom = primaryStatus.custom ?? {};
    return {
      ...primaryStatus,
      fallback: fallbackInfo,
      custom: {
        ...custom,
        fallback: { disabled: true, reason: this.lastError ?? "unknown" },
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      await this.deps.primary.sync?.(params);
      return;
    }
    const fallback = await this.ensureFallback();
    await fallback?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.probeEmbeddingAvailability();
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.probeEmbeddingAvailability();
    }
    return { ok: false, error: this.lastError ?? "memory embeddings unavailable" };
  }

  async probeVectorAvailability() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.probeVectorAvailability();
    }
    const fallback = await this.ensureFallback();
    return (await fallback?.probeVectorAvailability()) ?? false;
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.deps.primary.close?.();
    await this.fallback?.close?.();
    this.evictCacheEntry();
  }

  async invalidate(reason: string) {
    this.closeReason = reason;
    await this.close();
  }

  private async ensureFallback(): Promise<Maybe<MemorySearchManager>> {
    if (this.fallback) {
      return this.fallback;
    }
    let fallback: Maybe<MemorySearchManager>;
    try {
      fallback = await this.deps.fallbackFactory();
      if (!fallback) {
        log.warn("memory fallback requested but builtin index is unavailable");
        return null;
      }
    } catch (err) {
      const message = formatErrorMessage(err);
      log.warn(`memory fallback unavailable: ${message}`);
      return null;
    }
    this.fallback = fallback;
    return this.fallback;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error(this.closeReason);
    }
  }

  private evictCacheEntry(): void {
    if (this.cacheEvicted) {
      return;
    }
    this.cacheEvicted = true;
    this.onClose?.();
  }
}

async function closeQmdManagerForReplacement(manager: MemorySearchManager): Promise<void> {
  if (manager instanceof FallbackMemoryManager) {
    await manager.invalidate("memory search manager was replaced by a newer qmd manager");
    return;
  }
  await manager.close?.();
}

function buildQmdManagerScopeKey(agentId: string): string {
  return agentId;
}

function buildQmdManagerIdentityKey(
  agentId: string,
  config: ResolvedQmdConfig,
  runtimeConfig: QmdManagerRuntimeConfig,
): string {
  // ResolvedQmdConfig is assembled in a stable field order in resolveMemoryBackendConfig.
  // Fast stringify avoids deep key-sorting overhead on this hot path.
  return `${agentId}:${JSON.stringify(config)}:${JSON.stringify(runtimeConfig.syncSettings ?? null)}:${JSON.stringify(runtimeConfig.contextLimits ?? null)}:${runtimeConfig.workspaceDir}`;
}

function resolveQmdManagerRuntimeConfig(
  cfg: OpenClawConfig,
  agentId: string,
): QmdManagerRuntimeConfig {
  return {
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    syncSettings: resolveMemorySearchSyncConfig(cfg, agentId),
    contextLimits: resolveAgentContextLimits(cfg, agentId),
  };
}
