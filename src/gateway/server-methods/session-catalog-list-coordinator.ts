type CacheEntry<T> = {
  value: T;
  freshUntil: number;
  staleUntil: number;
};

type SessionCatalogListCoordinatorOptions = {
  freshTtlMs: number;
  staleTtlMs: number;
  maxCacheEntries: number;
  maxConcurrentLoads: number;
  maxQueuedLoads?: number;
  now?: () => number;
};

type SessionCatalogListCacheKeyInput = {
  catalogIds: readonly string[];
  agentId: string;
  search?: string;
  limitPerHost?: number;
  hostIds?: readonly string[];
  cursors?: Readonly<Record<string, string>>;
};

export class SessionCatalogListBusyError extends Error {
  constructor() {
    super("session catalog is busy; retry shortly");
    this.name = "SessionCatalogListBusyError";
  }
}

type QueuedLoad = {
  resolve: () => void;
};

export function buildSessionCatalogListCacheKey(input: SessionCatalogListCacheKeyInput): string {
  return JSON.stringify([
    [...input.catalogIds].toSorted(),
    input.agentId,
    input.search ?? null,
    input.limitPerHost ?? null,
    input.hostIds ? [...input.hostIds].toSorted() : null,
    input.cursors
      ? Object.entries(input.cursors).toSorted(([left], [right]) => left.localeCompare(right))
      : null,
  ]);
}

/**
 * Bounds the external session-catalog hot path for one Gateway process.
 * Followers share an in-flight load; brief stale data is used only under admission pressure.
 */
export class SessionCatalogListCoordinator<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly queuedLoads: QueuedLoad[] = [];
  private readonly now: () => number;
  private readonly maxQueuedLoads: number;
  private activeLoads = 0;

  constructor(private readonly options: SessionCatalogListCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.maxQueuedLoads = options.maxQueuedLoads ?? options.maxConcurrentLoads * 8;
  }

  async run(params: {
    key: string;
    load: () => Promise<T>;
    cacheable: (value: T) => boolean;
  }): Promise<T> {
    const fresh = this.readCache(params.key, true);
    if (fresh !== undefined) {
      return fresh;
    }

    const pending = this.inFlight.get(params.key);
    if (pending) {
      return pending;
    }

    if (this.activeLoads >= this.options.maxConcurrentLoads) {
      const stale = this.readCache(params.key, false);
      if (stale !== undefined) {
        return stale;
      }
      await this.waitForAdmission();
      return this.run(params);
    }

    this.activeLoads += 1;
    const pendingLoad = params
      .load()
      .then((value) => {
        if (params.cacheable(value)) {
          this.writeCache(params.key, value);
        }
        return value;
      })
      .finally(() => {
        this.activeLoads -= 1;
        this.inFlight.delete(params.key);
        this.releaseQueuedLoad();
      });
    this.inFlight.set(params.key, pendingLoad);
    return pendingLoad;
  }

  private waitForAdmission(): Promise<void> {
    if (this.queuedLoads.length >= this.maxQueuedLoads) {
      throw new SessionCatalogListBusyError();
    }
    return new Promise((resolve) => {
      this.queuedLoads.push({ resolve });
    });
  }

  private releaseQueuedLoad() {
    this.queuedLoads.shift()?.resolve();
  }

  private readCache(key: string, requireFresh: boolean): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    const now = this.now();
    if (entry.staleUntil <= now) {
      this.cache.delete(key);
      return undefined;
    }
    if (requireFresh && entry.freshUntil <= now) {
      return undefined;
    }
    // Refresh insertion order so frequently used keys survive the bounded LRU.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  private writeCache(key: string, value: T) {
    const now = this.now();
    this.cache.delete(key);
    this.cache.set(key, {
      value,
      freshUntil: now + this.options.freshTtlMs,
      staleUntil: now + this.options.staleTtlMs,
    });
    while (this.cache.size > this.options.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }
}
