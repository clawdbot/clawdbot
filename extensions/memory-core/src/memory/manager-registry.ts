// Memory Core plugin module owns manager cache and close serialization.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveGlobalSingleton,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  resolveMemoryCoreLocalServiceHostIdentity,
  type MemoryCoreAcquireLocalService,
} from "./embedding-local-service.js";
import { getOrCreateManagedCacheEntry, resolveSingletonManagedCache } from "./manager-cache.js";

const MEMORY_INDEX_MANAGER_CACHE_KEY = Symbol.for("openclaw.memoryIndexManagerCache");
const MEMORY_INDEX_MANAGER_SCOPE_CLOSES_KEY = Symbol.for("openclaw.memoryIndexManagerScopeCloses");
const MEMORY_INDEX_MANAGER_GLOBAL_LIFECYCLE_KEY = Symbol.for(
  "openclaw.memoryIndexManagerGlobalLifecycle.v3",
);
const log = createSubsystemLogger("memory");

export type MemoryIndexManagerPurpose = "default" | "status" | "cli";

type ClosableMemoryManager = {
  close(): Promise<void>;
};

type PreparedMemoryManager<T extends ClosableMemoryManager> = {
  key: string;
  transient: boolean;
  create: () => Promise<T> | T;
  reuse: (manager: T) => boolean;
};

type MemoryManagerRegistryCallbacks<T extends ClosableMemoryManager> = {
  prepare: () => Promise<PreparedMemoryManager<T> | null> | PreparedMemoryManager<T> | null;
  close: (manager: T) => Promise<void>;
};

type MemoryManagerRegistryGlobalLifecycle = {
  closePromise: Promise<void> | null;
  closeFailed: boolean;
};

export function resolveMemoryIndexManagerCacheKey(params: {
  agentId: string;
  workspaceDir: string;
  settings: ResolvedMemorySearchConfig;
  providerRequirement: unknown;
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

export class MemoryManagerRegistry<T extends ClosableMemoryManager> {
  private readonly cache: Map<string, T>;
  private readonly pending: Map<string, Promise<T>>;
  private readonly scopeOperations: Map<string, Promise<void>>;
  private readonly globalLifecycle: MemoryManagerRegistryGlobalLifecycle;

  constructor() {
    const managedCache = resolveSingletonManagedCache<T>(MEMORY_INDEX_MANAGER_CACHE_KEY);
    this.cache = managedCache.cache;
    this.pending = managedCache.pending;
    this.scopeOperations = resolveGlobalSingleton<Map<string, Promise<void>>>(
      MEMORY_INDEX_MANAGER_SCOPE_CLOSES_KEY,
      () => new Map(),
    );
    this.globalLifecycle = resolveGlobalSingleton<MemoryManagerRegistryGlobalLifecycle>(
      MEMORY_INDEX_MANAGER_GLOBAL_LIFECYCLE_KEY,
      () => ({ closePromise: null, closeFailed: false }),
    );
  }

  async acquire(
    params: { agentId: string; purpose: MemoryIndexManagerPurpose },
    callbacks: MemoryManagerRegistryCallbacks<T>,
  ): Promise<T | null> {
    return await this.runScopeOperation(params, async () => {
      if (this.globalLifecycle.closeFailed) {
        await this.retryFailedGlobalClose(callbacks.close);
      }
      const prepared = await callbacks.prepare();
      if (!prepared) {
        return null;
      }
      const getOrCreate = async () =>
        await getOrCreateManagedCacheEntry({
          cache: this.cache,
          pending: this.pending,
          key: prepared.key,
          bypassCache: prepared.transient,
          create: prepared.create,
        });
      if (prepared.transient) {
        return await getOrCreate();
      }
      const cachedManager = this.cache.get(prepared.key);
      await this.closeScopeUnlocked(
        {
          agentId: params.agentId,
          purpose: params.purpose,
          ...(cachedManager && prepared.reuse(cachedManager) ? { exceptKey: prepared.key } : {}),
        },
        callbacks.close,
      );
      return await getOrCreate();
    });
  }

  async closeAll(close: (manager: T) => Promise<void>): Promise<void> {
    await this.runGlobalClose(async () => {
      try {
        await this.closeAllUnlocked(close);
        this.globalLifecycle.closeFailed = false;
      } catch (err) {
        this.globalLifecycle.closeFailed = true;
        throw err;
      }
    });
  }

  async closeForAgent(params: {
    agentId: string;
    purpose: MemoryIndexManagerPurpose;
    close: (manager: T) => Promise<void>;
  }): Promise<void> {
    const scope = { agentId: normalizeAgentId(params.agentId), purpose: params.purpose };
    await this.runScopeOperation(scope, async () => {
      await this.closeScopeUnlocked(scope, params.close);
    });
  }

  deleteIfCurrent(key: string, manager: T): void {
    if (this.cache.get(key) === manager) {
      this.cache.delete(key);
    }
  }

  private async retryFailedGlobalClose(close: (manager: T) => Promise<void>): Promise<void> {
    try {
      await this.closeAllUnlocked(close);
      this.globalLifecycle.closeFailed = false;
    } catch (err) {
      this.globalLifecycle.closeFailed = true;
      throw err;
    }
  }

  private async runGlobalClose(operation: () => Promise<void>): Promise<void> {
    const previous = this.globalLifecycle.closePromise ?? Promise.resolve();
    const closePromise = previous.then(operation, operation);
    this.globalLifecycle.closePromise = closePromise;
    await closePromise;
    if (this.globalLifecycle.closePromise === closePromise) {
      this.globalLifecycle.closePromise = null;
    }
  }

  private async runScopeOperation<R>(
    params: { agentId: string; purpose: MemoryIndexManagerPurpose },
    operation: () => Promise<R>,
  ): Promise<R> {
    while (this.globalLifecycle.closePromise) {
      const globalClose = this.globalLifecycle.closePromise;
      try {
        await globalClose;
      } catch {
        if (this.globalLifecycle.closePromise === globalClose) {
          await this.closeAll(async (manager) => await manager.close());
        }
      }
    }
    const scopeKey = JSON.stringify([params.agentId, params.purpose]);
    const previousOperation = this.scopeOperations.get(scopeKey) ?? Promise.resolve();
    const result = previousOperation.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.scopeOperations.set(scopeKey, tail);
    try {
      return await result;
    } finally {
      if (this.scopeOperations.get(scopeKey) === tail) {
        this.scopeOperations.delete(scopeKey);
      }
    }
  }

  private async closeAllUnlocked(close: (manager: T) => Promise<void>): Promise<void> {
    const scopedOperations = Array.from(this.scopeOperations.values());
    if (scopedOperations.length > 0) {
      await Promise.allSettled(scopedOperations);
    }
    const pending = Array.from(this.pending.values());
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    await this.closeEntries(Array.from(this.cache.entries()), close);
  }

  private async closeScopeUnlocked(
    params: {
      agentId: string;
      purpose: MemoryIndexManagerPurpose;
      exceptKey?: string;
    },
    close: (manager: T) => Promise<void>,
  ): Promise<void> {
    const isScopedKey = (key: string) =>
      key !== params.exceptKey &&
      key.startsWith(`${params.agentId}:`) &&
      key.endsWith(`:${params.purpose}`);
    const pending = Array.from(this.pending.entries())
      .filter(([key]) => isScopedKey(key))
      .map(([, value]) => value);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    await this.closeEntries(
      Array.from(this.cache.entries()).filter(([key]) => isScopedKey(key)),
      close,
      params.agentId,
    );
  }

  private async closeEntries(
    entries: Array<[string, T]>,
    close: (manager: T) => Promise<void>,
    agentId?: string,
  ): Promise<void> {
    let firstError: unknown;
    for (const [key, manager] of entries) {
      try {
        await close(manager);
        this.deleteIfCurrent(key, manager);
      } catch (err) {
        firstError ??= err;
        const scope = agentId ? ` for agent ${agentId}` : "";
        log.warn(`failed to close memory index manager${scope}: ${String(err)}`);
      }
    }
    if (firstError !== undefined) {
      throw toErrorObject(firstError, "Failed to close memory index manager");
    }
  }
}
