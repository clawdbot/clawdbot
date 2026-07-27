import { createHash } from "node:crypto";
// Memory Core plugin module implements search manager behavior.
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createSubsystemLogger,
  resolveAgentContextLimits,
  resolveAgentWorkspaceDir,
  resolveGlobalSingleton,
  resolveMemorySearchSyncConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  checkQmdBinaryAvailability,
  resolveQmdBinaryUnavailableReason,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  resolveMemoryBackendConfig,
  type MemoryEmbeddingProbeResult,
  type MemorySearchManager,
  type MemorySearchRuntimeDebug,
  type MemorySource,
  type MemorySyncParams,
  type ResolvedQmdConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  resolveMemoryCoreLocalServiceHostIdentity,
  type MemoryCoreAcquireLocalService,
} from "./embedding-local-service.js";
import { resolveMemoryCoreLeaseHostIdentity } from "./runtime-host.js";
import {
  DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  runMemorySearchWithDeadline,
  type MemorySearchDeadlineControlOptions,
} from "./search-deadline.js";

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

type QmdManagerOpenFailure = {
  identityKey: string;
  reason: string;
  retryAfterMs: number;
};

type MemorySearchManagerCacheState =
  | "cached-full-hit"
  | "cached-full-miss"
  | "transient-cli"
  | "transient-status"
  | "pending-create-wait"
  | "fallback-builtin"
  | "recent-failure-cooldown";

type MemorySearchManagerDebug = {
  backend?: "builtin" | "qmd";
  purpose?: MemorySearchManagerPurpose;
  managerMs?: number;
  managerCacheState?: MemorySearchManagerCacheState;
  qmdIdentityHash?: string;
  failureCode?: "qmd-unavailable";
};

type MemorySearchManagerCacheStore = {
  qmdManagerCache: Map<string, CachedQmdManagerEntry>;
  pendingQmdManagerCreates: Map<string, PendingQmdManagerCreate>;
  qmdManagerOpenFailures: Map<string, QmdManagerOpenFailure>;
  retainedQmdManagers: Map<string, Set<MemorySearchManager>>;
  scopeLifecycleTails: Map<string, Promise<void>>;
  globalClosePromise: Promise<void> | null;
};

const QMD_MANAGER_OPEN_FAILURE_COOLDOWN_MS = 60_000;

function createMemorySearchManagerCacheStore(): MemorySearchManagerCacheStore {
  return {
    qmdManagerCache: new Map<string, CachedQmdManagerEntry>(),
    pendingQmdManagerCreates: new Map<string, PendingQmdManagerCreate>(),
    qmdManagerOpenFailures: new Map<string, QmdManagerOpenFailure>(),
    retainedQmdManagers: new Map<string, Set<MemorySearchManager>>(),
    scopeLifecycleTails: new Map<string, Promise<void>>(),
    globalClosePromise: null,
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
    const cacheStore = resolved as Partial<MemorySearchManagerCacheStore>;
    if (!(cacheStore.qmdManagerOpenFailures instanceof Map)) {
      cacheStore.qmdManagerOpenFailures = new Map<string, QmdManagerOpenFailure>();
    }
    if (!(cacheStore.scopeLifecycleTails instanceof Map)) {
      cacheStore.scopeLifecycleTails = new Map<string, Promise<void>>();
    }
    if (!(cacheStore.retainedQmdManagers instanceof Map)) {
      cacheStore.retainedQmdManagers = new Map<string, Set<MemorySearchManager>>();
    }
    if (
      cacheStore.globalClosePromise !== null &&
      !(cacheStore.globalClosePromise instanceof Promise)
    ) {
      cacheStore.globalClosePromise = null;
    }
    return cacheStore as MemorySearchManagerCacheStore;
  }
  const repaired = createMemorySearchManagerCacheStore();
  (globalThis as Record<PropertyKey, unknown>)[MEMORY_SEARCH_MANAGER_CACHE_KEY] = repaired;
  return repaired;
}

const log = createSubsystemLogger("memory");
const MEMORY_SEARCH_MANAGER_CACHE_STORE = getMemorySearchManagerCacheStore();
const {
  qmdManagerCache: QMD_MANAGER_CACHE,
  pendingQmdManagerCreates: PENDING_QMD_MANAGER_CREATES,
  qmdManagerOpenFailures: QMD_MANAGER_OPEN_FAILURES,
} = MEMORY_SEARCH_MANAGER_CACHE_STORE;

function retainQmdManagerForCleanup(scopeKey: string, manager: MemorySearchManager): void {
  const retained = MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.get(scopeKey) ?? new Set();
  retained.add(manager);
  MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.set(scopeKey, retained);
}

function releaseRetainedQmdManager(scopeKey: string, manager: MemorySearchManager): void {
  const retained = MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.get(scopeKey);
  if (!retained) {
    return;
  }
  retained.delete(manager);
  if (retained.size === 0) {
    MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.delete(scopeKey);
  }
}

async function drainRetainedQmdManagers(scopeKey: string): Promise<void> {
  const retained = MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.get(scopeKey);
  if (!retained) {
    return;
  }
  let firstError: unknown;
  let closeFailed = false;
  for (const manager of retained) {
    try {
      await manager.close?.();
      retained.delete(manager);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (retained.size === 0) {
    MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.delete(scopeKey);
  }
  if (closeFailed) {
    throw firstError;
  }
}

async function runMemorySearchManagerScopeOperation<T>(
  scopeKey: string,
  operation: () => Promise<T>,
  options: { drainRetained?: boolean } = {},
): Promise<T> {
  while (MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise) {
    const globalClose = MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise;
    try {
      await globalClose;
    } catch {
      if (MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise === globalClose) {
        await closeAllMemorySearchManagers();
      }
    }
  }
  const previous =
    MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.get(scopeKey) ?? Promise.resolve();
  const run = async () => {
    if (options.drainRetained !== false) {
      await drainRetainedQmdManagers(scopeKey);
    }
    return await operation();
  };
  const result = previous.then(run, run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.set(scopeKey, tail);
  try {
    return await result;
  } finally {
    if (MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.get(scopeKey) === tail) {
      MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.delete(scopeKey);
    }
  }
}

async function runMemorySearchManagerGlobalClose(operation: () => Promise<void>): Promise<void> {
  const previous = MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise ?? Promise.resolve();
  const closePromise = previous.then(operation, operation);
  MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise = closePromise;
  await closePromise;
  if (MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise === closePromise) {
    MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise = null;
  }
}

function retireQmdManagerInScope(scopeKey: string, manager: MemorySearchManager): void {
  retainQmdManagerForCleanup(scopeKey, manager);
  void runMemorySearchManagerScopeOperation(
    scopeKey,
    async () => {
      await manager.close?.();
      releaseRetainedQmdManager(scopeKey, manager);
    },
    { drainRetained: false },
  ).catch((err: unknown) => {
    log.warn(`failed to retire qmd memory manager: ${formatErrorMessage(err)}`);
  });
}
const managerRuntimeLoader = createLazyRuntimeModule(() => import("../../manager-runtime.js"));
const loadManagerRuntime = managerRuntimeLoader;

const loadQmdManagerModule = createLazyRuntimeModule(() => import("./qmd-manager.js"));

type MemorySearchManagerResult = {
  manager: Maybe<MemorySearchManager>;
  error?: string;
  debug?: MemorySearchManagerDebug;
};

type MemorySearchManagerPurpose = "default" | "status" | "cli";
type MemorySearchManagerParams = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
};

function isClosedMemorySearchManager(manager: MemorySearchManager): boolean {
  const isClosed = Reflect.get(manager, "isClosed");
  return typeof isClosed === "function" && isClosed.call(manager) === true;
}

function getActiveQmdManagerOpenFailure(
  scopeKey: string,
  identityKey: string,
  nowMs = Date.now(),
): QmdManagerOpenFailure | null {
  const failure = QMD_MANAGER_OPEN_FAILURES.get(scopeKey);
  if (!failure) {
    return null;
  }
  if (failure.identityKey !== identityKey || failure.retryAfterMs <= nowMs) {
    QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
    return null;
  }
  return failure;
}

function recordQmdManagerOpenFailure(
  scopeKey: string,
  identityKey: string,
  reason: string,
  nowMs = Date.now(),
): void {
  QMD_MANAGER_OPEN_FAILURES.set(scopeKey, {
    identityKey,
    reason,
    retryAfterMs: nowMs + QMD_MANAGER_OPEN_FAILURE_COOLDOWN_MS,
  });
}

function clearQmdManagerOpenFailure(scopeKey: string, identityKey: string): void {
  const failure = QMD_MANAGER_OPEN_FAILURES.get(scopeKey);
  if (failure?.identityKey === identityKey) {
    QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
  }
}

function hashQmdManagerIdentity(identityKey: string): string {
  return createHash("sha256").update(identityKey).digest("hex");
}

function applyManagerDebug(
  result: MemorySearchManagerResult,
  debug: MemorySearchManagerDebug,
): MemorySearchManagerResult {
  if (result.debug && Object.keys(result.debug).length > 0 && Object.keys(debug).length === 0) {
    return result;
  }
  return {
    ...result,
    debug: {
      ...result.debug,
      ...debug,
    },
  };
}

export async function getMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  const scopeKey = buildQmdManagerScopeKey(normalizeAgentId(params.agentId));
  const resolved = resolveMemoryBackendConfig(params);
  return await runMemorySearchManagerScopeOperation(
    scopeKey,
    async () => await getMemorySearchManagerWithinLifecycle(params),
    { drainRetained: resolved.backend === "qmd" },
  );
}

async function getMemorySearchManagerWithinLifecycle(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  const acquireStartedAt = Date.now();
  const purpose = params.purpose ?? "default";
  const finish = (
    result: MemorySearchManagerResult,
    debug: MemorySearchManagerDebug,
  ): MemorySearchManagerResult =>
    applyManagerDebug(result, {
      purpose,
      managerMs: Math.max(0, Date.now() - acquireStartedAt),
      ...debug,
    });
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "qmd" && resolved.qmd) {
    const qmdResolved = resolved.qmd;
    const normalizedAgentId = normalizeAgentId(params.agentId);
    const runtimeConfig = resolveQmdManagerRuntimeConfig(params.cfg, normalizedAgentId);
    const { workspaceDir } = runtimeConfig;
    const transient = params.purpose === "status" || params.purpose === "cli";
    const scopeKey = buildQmdManagerScopeKey(normalizedAgentId);
    const identityKey = buildQmdManagerIdentityKey(
      normalizedAgentId,
      qmdResolved,
      runtimeConfig,
      params.acquireLocalService,
      params.withLease,
    );
    const debugIdentityHash = hashQmdManagerIdentity(identityKey);

    const createPrimaryQmdManager = async (
      mode: "full" | "status" | "cli",
    ): Promise<{ manager: Maybe<MemorySearchManager>; failureReason?: string }> => {
      if (!params.withLease) {
        const message = "memory-core host does not provide SQLite lease coordination";
        log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
        return { manager: null, failureReason: `qmd memory unavailable: ${message}` };
      }
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
      } catch (err) {
        const message = formatErrorMessage(err);
        log.warn(
          `qmd workspace unavailable (${workspaceDir}); falling back to builtin: ${message}`,
        );
        return {
          manager: null,
          failureReason: `qmd workspace unavailable (${workspaceDir}): ${message}`,
        };
      }

      const qmdBinary = await checkQmdBinaryAvailability({
        command: qmdResolved.command,
        env: process.env,
        cwd: workspaceDir,
      });
      if (!qmdBinary.available) {
        const message = qmdBinary.error;
        const failurePrefix =
          resolveQmdBinaryUnavailableReason(qmdBinary) === "workspace-cwd"
            ? `qmd workspace unavailable (${workspaceDir})`
            : `qmd binary unavailable (${qmdResolved.command})`;
        log.warn(`${failurePrefix}; falling back to builtin: ${message}`);
        return {
          manager: null,
          failureReason: `${failurePrefix}: ${message}`,
        };
      }
      try {
        const { QmdMemoryManager } = await loadQmdManagerModule();
        const primary = await QmdMemoryManager.create({
          cfg: params.cfg,
          agentId: normalizedAgentId,
          resolved: { ...resolved, qmd: qmdResolved },
          mode,
          runtimeConfig,
          withLease: params.withLease,
        });
        if (primary) {
          clearQmdManagerOpenFailure(scopeKey, identityKey);
          return { manager: primary };
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
        return { manager: null, failureReason: `qmd memory unavailable: ${message}` };
      }
      return { manager: null, failureReason: "qmd memory unavailable: no manager returned" };
    };

    const createFullQmdManager = async (
      expectedIdentityKey: string,
    ): Promise<{ entry: Maybe<CachedQmdManagerEntry>; failureReason?: string }> => {
      const { manager: primary, failureReason } = await createPrimaryQmdManager("full");
      if (!primary) {
        return { entry: null, failureReason };
      }
      const wrapper = new FallbackMemoryManager(
        {
          primary,
          retirePrimary: () => retireQmdManagerInScope(scopeKey, primary),
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
      const cacheEntry: CachedQmdManagerEntry = {
        identityKey: expectedIdentityKey,
        manager: wrapper,
      };
      return { entry: cacheEntry };
    };

    let cached = QMD_MANAGER_CACHE.get(scopeKey);
    if (cached && isClosedMemorySearchManager(cached.manager)) {
      await cached.manager.close?.();
      if (QMD_MANAGER_CACHE.get(scopeKey) === cached) {
        QMD_MANAGER_CACHE.delete(scopeKey);
      }
      cached = undefined;
    }
    const cachedMatchesIdentity = cached?.identityKey === identityKey;
    if (cachedMatchesIdentity && cached) {
      if (params.purpose === "status") {
        // Status callers often close the manager they receive. Wrap the live
        // full manager with a no-op close so health/status probes do not tear
        // down the active QMD manager for the process.
        return finish(
          { manager: new BorrowedMemoryManager(cached.manager) },
          {
            backend: "qmd",
            managerCacheState: "cached-full-hit",
            qmdIdentityHash: debugIdentityHash,
          },
        );
      }
      if (params.purpose !== "cli") {
        return finish(
          { manager: cached.manager },
          {
            backend: "qmd",
            managerCacheState: "cached-full-hit",
            qmdIdentityHash: debugIdentityHash,
          },
        );
      }
    }

    if (transient) {
      const { manager, failureReason } = await createPrimaryQmdManager(
        params.purpose === "cli" ? "cli" : "status",
      );
      return manager
        ? finish(
            { manager },
            {
              backend: "qmd",
              managerCacheState: params.purpose === "cli" ? "transient-cli" : "transient-status",
              qmdIdentityHash: debugIdentityHash,
            },
          )
        : finish(await getBuiltinMemorySearchManagerAfterQmdFailure(params, failureReason), {
            backend: "qmd",
            managerCacheState: "fallback-builtin",
            qmdIdentityHash: debugIdentityHash,
            failureCode: "qmd-unavailable",
          });
    }

    const recentFailure = getActiveQmdManagerOpenFailure(scopeKey, identityKey);
    if (recentFailure) {
      log.debug?.(`qmd memory unavailable; using builtin during cooldown: ${recentFailure.reason}`);
      return finish(
        await getBuiltinMemorySearchManagerAfterQmdFailure(params, recentFailure.reason),
        {
          backend: "qmd",
          managerCacheState: "recent-failure-cooldown",
          qmdIdentityHash: debugIdentityHash,
          failureCode: "qmd-unavailable",
        },
      );
    }

    const pending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
    if (pending) {
      await pending.promise;
      return finish(await getMemorySearchManagerWithinLifecycle(params), {
        backend: "qmd",
        managerCacheState: "pending-create-wait",
        qmdIdentityHash: debugIdentityHash,
      });
    }

    let pendingFailureReason: string | undefined;
    const pendingCreate: PendingQmdManagerCreate = {
      identityKey,
      promise: (async () => {
        const created = await createFullQmdManager(identityKey);
        if (!created.entry) {
          pendingFailureReason = created.failureReason ?? "qmd memory unavailable";
          recordQmdManagerOpenFailure(scopeKey, identityKey, pendingFailureReason);
          return null;
        }
        if (cached) {
          try {
            await closeQmdManagerForReplacement(cached.manager);
          } catch (err) {
            retainQmdManagerForCleanup(scopeKey, created.entry.manager);
            try {
              await created.entry.manager.close?.();
              releaseRetainedQmdManager(scopeKey, created.entry.manager);
            } catch (closeErr) {
              log.warn(
                `failed to close unused qmd memory manager: ${formatErrorMessage(closeErr)}`,
              );
            }
            throw err;
          }
        }
        QMD_MANAGER_CACHE.set(scopeKey, created.entry);
        return created.entry.manager;
      })().finally(() => {
        const currentPending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
        if (currentPending === pendingCreate) {
          PENDING_QMD_MANAGER_CREATES.delete(scopeKey);
        }
      }),
    };
    PENDING_QMD_MANAGER_CREATES.set(scopeKey, pendingCreate);
    const manager = await pendingCreate.promise;
    return manager
      ? finish(
          { manager },
          {
            backend: "qmd",
            managerCacheState: "cached-full-miss",
            qmdIdentityHash: debugIdentityHash,
          },
        )
      : finish(await getBuiltinMemorySearchManagerAfterQmdFailure(params, pendingFailureReason), {
          backend: "qmd",
          managerCacheState: "fallback-builtin",
          qmdIdentityHash: debugIdentityHash,
          failureCode: "qmd-unavailable",
        });
  }

  return finish(await getBuiltinMemorySearchManager(params), {
    backend: "builtin",
  });
}

async function getBuiltinMemorySearchManagerAfterQmdFailure(
  params: MemorySearchManagerParams,
  qmdFailureReason: string | undefined,
): Promise<MemorySearchManagerResult> {
  const fallback = await getBuiltinMemorySearchManager(params);
  if (fallback.manager || !qmdFailureReason) {
    return fallback;
  }
  const fallbackError = fallback.error?.trim();
  return {
    manager: null,
    error: fallbackError
      ? `${qmdFailureReason}; builtin fallback unavailable: ${fallbackError}`
      : qmdFailureReason,
  };
}

async function getBuiltinMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
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
  readonly probeVectorStoreAvailability?: () => Promise<boolean>;

  constructor(private readonly inner: MemorySearchManager) {
    if (inner.probeVectorStoreAvailability) {
      const probeVectorStoreAvailability = inner.probeVectorStoreAvailability.bind(inner);
      this.probeVectorStoreAvailability = async () => await probeVectorStoreAvailability();
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      signal?: AbortSignal;
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

  async sync(params?: MemorySyncParams) {
    await this.inner.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return await this.inner.probeEmbeddingAvailability();
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    return this.inner.getCachedEmbeddingAvailability?.() ?? null;
  }

  async probeVectorAvailability() {
    return await this.inner.probeVectorAvailability();
  }

  async close() {}
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  await runMemorySearchManagerGlobalClose(closeAllMemorySearchManagersWithinLifecycle);
}

async function closeAllMemorySearchManagersWithinLifecycle(): Promise<void> {
  const scopeTails = Array.from(MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.values());
  if (scopeTails.length > 0) {
    await Promise.allSettled(scopeTails);
  }
  const pendingCreates = Array.from(PENDING_QMD_MANAGER_CREATES.values(), (entry) => entry.promise);
  await Promise.allSettled(pendingCreates);
  const entries = Array.from(QMD_MANAGER_CACHE.entries());
  QMD_MANAGER_OPEN_FAILURES.clear();
  let firstError: unknown;
  let closeFailed = false;
  for (const scopeKey of Array.from(MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.keys())) {
    try {
      await drainRetainedQmdManagers(scopeKey);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  for (const [scopeKey, entry] of entries) {
    try {
      await entry.manager.close?.();
      if (QMD_MANAGER_CACHE.get(scopeKey) === entry) {
        QMD_MANAGER_CACHE.delete(scopeKey);
      }
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
      log.warn(`failed to close qmd memory manager: ${String(err)}`);
    }
  }
  if (managerRuntimeLoader.peek()) {
    try {
      const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
      await closeAllMemoryIndexManagers();
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (closeFailed) {
    throw firstError;
  }
}

export async function closeMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const scopeKey = buildQmdManagerScopeKey(normalizeAgentId(params.agentId));
  await runMemorySearchManagerScopeOperation(
    scopeKey,
    async () => await closeMemorySearchManagerWithinLifecycle(params),
    { drainRetained: false },
  );
}

async function closeMemorySearchManagerWithinLifecycle(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const scopeKey = buildQmdManagerScopeKey(normalizedAgentId);
  let closeError: unknown;
  let closeFailed = false;
  try {
    await drainRetainedQmdManagers(scopeKey);
  } catch (err) {
    closeError = err;
    closeFailed = true;
  }
  const pending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
  if (pending) {
    await Promise.allSettled([pending.promise]);
  }
  const cached = QMD_MANAGER_CACHE.get(scopeKey);
  if (cached) {
    try {
      await cached.manager.close?.();
      if (QMD_MANAGER_CACHE.get(scopeKey) === cached) {
        QMD_MANAGER_CACHE.delete(scopeKey);
      }
      QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
    } catch (err) {
      closeError = err;
      closeFailed = true;
      log.warn(`failed to close qmd memory manager for agent ${normalizedAgentId}: ${String(err)}`);
    }
  }
  if (managerRuntimeLoader.peek()) {
    try {
      const { closeMemoryIndexManagersForAgent } = await loadManagerRuntime();
      await closeMemoryIndexManagersForAgent({ cfg: params.cfg, agentId: normalizedAgentId });
    } catch (err) {
      if (!closeFailed) {
        closeError = err;
      }
      closeFailed = true;
    }
  }
  if (closeFailed) {
    throw closeError;
  }
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: Maybe<MemorySearchManager> = null;
  private fallbackInitPromise: Promise<Maybe<MemorySearchManager>> | null = null;
  private primaryFailed = false;
  private lastError?: string;
  private cacheEvicted = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private closeReason = "memory search manager is closed";

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      retirePrimary: () => void;
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
      sources?: MemorySource[];
      signal?: AbortSignal;
    },
  ) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      try {
        return await this.deps.primary.search(query, opts);
      } catch (err) {
        // Caller cancellation is request-scoped, not a QMD health failure.
        // Keep the shared manager active for concurrent and later searches.
        if (opts?.signal?.aborted) {
          throw err;
        }
        this.primaryFailed = true;
        this.lastError = formatErrorMessage(err);
        log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
        this.deps.retirePrimary();
        // Evict the failed wrapper so the next request can retry QMD with a fresh manager.
        this.evictCacheEntry();
      }
    }
    // The fallback owns a fresh default budget. Release any outer QMD clock
    // before builtin setup so earlier QMD maintenance cannot shorten it.
    (opts as MemorySearchDeadlineControlOptions | undefined)?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.(
      "handoff",
    );
    // Expose the backend transition before fallback setup starts. This must run
    // for concurrent and later calls that observe an already-failed primary too.
    opts?.onDebug?.({ backend: "builtin" });
    // Calls already queued on this failed wrapper must receive the same
    // bounded builtin setup and search budget as the first fallback call.
    return await runMemorySearchWithDeadline({
      timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
      parentSignal: opts?.signal,
      run: async (signal) => {
        const fallback = await this.ensureFallback();
        if (!fallback) {
          throw new Error(this.lastError ?? "memory search unavailable");
        }
        return await fallback.search(query, { ...opts, signal });
      },
    });
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

  async sync(params?: MemorySyncParams) {
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

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return this.deps.primary.getCachedEmbeddingAvailability?.() ?? null;
    }
    return this.fallback?.getCachedEmbeddingAvailability?.() ?? null;
  }

  async probeVectorStoreAvailability() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await (this.deps.primary.probeVectorStoreAvailability?.() ??
        this.deps.primary.probeVectorAvailability());
    }
    const fallback = await this.ensureFallback();
    return (
      (await (fallback?.probeVectorStoreAvailability?.() ?? fallback?.probeVectorAvailability())) ??
      false
    );
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
    const existingClose = this.closePromise;
    if (existingClose) {
      await existingClose;
      return;
    }
    const closeOperation = this.closeOnce();
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

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const pendingFallback = this.fallbackInitPromise;
    await this.deps.primary.close?.();
    await pendingFallback;
    await this.fallback?.close?.();
    this.fallback = null;
    this.evictCacheEntry();
  }

  async invalidate(reason: string) {
    this.closeReason = reason;
    await this.close();
  }

  private async ensureFallback(): Promise<Maybe<MemorySearchManager>> {
    this.ensureOpen();
    if (this.fallback) {
      return this.fallback;
    }
    const pending = this.fallbackInitPromise;
    if (pending) {
      const fallback = await pending;
      this.ensureOpen();
      return fallback;
    }
    const initialization = (async (): Promise<Maybe<MemorySearchManager>> => {
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
      if (this.closed) {
        await fallback.close?.();
        if (this.fallback === fallback) {
          this.fallback = null;
        }
        return null;
      }
      return fallback;
    })();
    this.fallbackInitPromise = initialization;
    try {
      const fallback = await initialization;
      this.ensureOpen();
      return fallback;
    } finally {
      if (this.fallbackInitPromise === initialization) {
        this.fallbackInitPromise = null;
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error(this.closeReason);
    }
  }

  isClosed(): boolean {
    return this.closed;
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
  acquireLocalService: MemoryCoreAcquireLocalService | undefined,
  withLease: PluginStateLeaseRunner | undefined,
): string {
  // ResolvedQmdConfig is assembled in a stable field order in resolveMemoryBackendConfig.
  // Fast stringify avoids deep key-sorting overhead on this hot path.
  const localServiceHostId = resolveMemoryCoreLocalServiceHostIdentity(acquireLocalService);
  const leaseHostId = resolveMemoryCoreLeaseHostIdentity(withLease);
  return `${agentId}:${JSON.stringify(config)}:${JSON.stringify(runtimeConfig.syncSettings ?? null)}:${JSON.stringify(runtimeConfig.contextLimits ?? null)}:${runtimeConfig.workspaceDir}:${localServiceHostId}:${leaseHostId}`;
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
