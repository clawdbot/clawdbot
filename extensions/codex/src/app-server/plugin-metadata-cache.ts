/**
 * Process-local cache for successful Codex plugin/list snapshots.
 */
import type { v2 } from "./protocol.js";

// Matches the sibling app-inventory cache window: upstream refreshes its remote
// catalog in the background, so settled negatives must expire rather than deny
// a configured plugin for the whole process lifetime.
const CODEX_PLUGIN_METADATA_CACHE_TTL_MS = 60 * 60 * 1_000;

/** Plugin catalog query whose request shape affects the returned marketplaces. */
export type CodexPluginMetadataQueryKind = "curated-global" | "workspace-directory";

/** Request callback used to read Codex plugin metadata. */
type CodexPluginMetadataRequest = (
  method: "plugin/list",
  params: v2.PluginListParams,
) => Promise<v2.PluginListResponse>;

/** Successful plugin metadata snapshot scoped to one app-server runtime. */
type CodexPluginMetadataSnapshot = {
  appCacheKey: string;
  queryKind: CodexPluginMetadataQueryKind;
  response: v2.PluginListResponse;
};

type CachedCodexPluginMetadataEntry = {
  snapshot: CodexPluginMetadataSnapshot;
  expiresAtMs: number;
};

type LoadCodexPluginMetadataParams = {
  appCacheKey: string;
  queryKind: CodexPluginMetadataQueryKind;
  requestParams: v2.PluginListParams;
  request: CodexPluginMetadataRequest;
  /**
   * Guards against fail-open responses: upstream plugin/list only warns when a
   * remote catalog fetch fails with omitted marketplaceKinds, returning local
   * marketplaces with empty marketplaceLoadErrors. Such a snapshot must not
   * settle for the process lifetime, or configured plugins never recover.
   */
  cacheable?: (response: v2.PluginListResponse) => boolean;
};

type InFlightCodexPluginMetadataLoad = {
  appCacheKey: string;
  promise: Promise<CodexPluginMetadataSnapshot>;
};

/** Process-local plugin metadata cache with coalesced loads per query. */
export class CodexPluginMetadataCache {
  private readonly entries = new Map<string, CachedCodexPluginMetadataEntry>();
  private readonly inFlight = new Map<string, InFlightCodexPluginMetadataLoad>();
  private readonly generations = new Map<string, number>();
  private clearGeneration = 0;

  constructor(private readonly nowMs: () => number = Date.now) {}

  /** Returns a fresh cached snapshot without issuing a request. */
  read(
    appCacheKey: string,
    queryKind: CodexPluginMetadataQueryKind,
  ): CodexPluginMetadataSnapshot | undefined {
    const entryKey = buildMetadataCacheEntryKey(appCacheKey, queryKind);
    const entry = this.entries.get(entryKey);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAtMs <= this.nowMs()) {
      this.entries.delete(entryKey);
      return undefined;
    }
    return entry.snapshot;
  }

  /** Returns a fresh cached snapshot or coalesces one plugin/list request. */
  async load(params: LoadCodexPluginMetadataParams): Promise<CodexPluginMetadataSnapshot> {
    const entryKey = buildMetadataCacheEntryKey(params.appCacheKey, params.queryKind);
    const cached = this.read(params.appCacheKey, params.queryKind);
    if (cached) {
      return cached;
    }
    const pending = this.inFlight.get(entryKey);
    if (pending) {
      try {
        return await pending.promise;
      } catch {
        if (this.inFlight.get(entryKey) === pending) {
          this.inFlight.delete(entryKey);
        }
        return await this.load(params);
      }
    }

    const generation = this.generations.get(params.appCacheKey) ?? 0;
    const clearGeneration = this.clearGeneration;
    const promise = (async () => {
      const response = await params.request("plugin/list", params.requestParams);
      const snapshot = {
        appCacheKey: params.appCacheKey,
        queryKind: params.queryKind,
        response,
      } satisfies CodexPluginMetadataSnapshot;
      // Settled snapshots survive until install invalidation, identity change,
      // TTL expiry, restart, or test reset — never a per-turn refresh.
      if (
        generation === (this.generations.get(params.appCacheKey) ?? 0) &&
        clearGeneration === this.clearGeneration &&
        !hasMarketplaceLoadErrors(response) &&
        (params.cacheable?.(response) ?? true)
      ) {
        this.entries.set(entryKey, {
          snapshot,
          expiresAtMs: this.nowMs() + CODEX_PLUGIN_METADATA_CACHE_TTL_MS,
        });
      }
      return snapshot;
    })();
    this.inFlight.set(entryKey, { appCacheKey: params.appCacheKey, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(entryKey)?.promise === promise) {
        this.inFlight.delete(entryKey);
      }
    }
  }

  /** Invalidates all plugin metadata queries for one app-server runtime. */
  invalidate(appCacheKey: string): void {
    this.generations.set(appCacheKey, (this.generations.get(appCacheKey) ?? 0) + 1);
    for (const [entryKey, entry] of this.entries) {
      if (entry.snapshot.appCacheKey === appCacheKey) {
        this.entries.delete(entryKey);
      }
    }
    for (const [entryKey, pending] of this.inFlight) {
      if (pending.appCacheKey === appCacheKey) {
        this.inFlight.delete(entryKey);
      }
    }
  }

  /** Clears snapshots and prevents late in-flight loads from repopulating them. */
  clear(): void {
    this.clearGeneration += 1;
    this.generations.clear();
    this.entries.clear();
    this.inFlight.clear();
  }
}

/** Shared plugin metadata cache used by Codex app-server runtime paths. */
export const defaultCodexPluginMetadataCache = new CodexPluginMetadataCache();

function hasMarketplaceLoadErrors(response: v2.PluginListResponse): boolean {
  return (response.marketplaceLoadErrors?.length ?? 0) > 0;
}

function buildMetadataCacheEntryKey(
  appCacheKey: string,
  queryKind: CodexPluginMetadataQueryKind,
): string {
  return JSON.stringify([appCacheKey, queryKind]);
}
