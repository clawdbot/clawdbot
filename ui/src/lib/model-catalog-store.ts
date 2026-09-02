// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelCatalogResult } from "../api/types.ts";
import { invalidateChatMetadataStore } from "./chat/chat-metadata-store.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
// A picker open is an operator signal to revalidate, but full provider discovery can be slow.
const MODEL_CATALOG_REFRESH_COOLDOWN_MS = 5 * 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  refreshEligibleAt?: number;
  result: ModelCatalogResult;
  inFlight?: ModelCatalogPendingRequest;
  inFlightRefresh?: boolean;
  inFlightRejects?: boolean;
};

type ModelCatalogPendingRequest = {
  controller?: AbortController;
  promise: Promise<ModelCatalogResult>;
  subscribers: Set<object>;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, Map<string, ModelCatalogCacheEntry>>();

export function invalidateModelCatalogCache(client: GatewayBrowserClient): void {
  modelCatalogCache.delete(client);
}

function modelCatalogCacheFor(client: GatewayBrowserClient): Map<string, ModelCatalogCacheEntry> {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = new Map();
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

export async function loadModelCatalog(
  client: GatewayBrowserClient,
  opts: {
    agentId: string;
    preparedOnly?: boolean;
    refresh?: boolean;
    refreshIfDue?: boolean;
    rejectOnFailure?: boolean;
    signal?: AbortSignal;
  },
): Promise<ModelCatalogResult> {
  opts.signal?.throwIfAborted();
  const cache = modelCatalogCacheFor(client);
  const agentId = opts.agentId.trim();
  const rejectOnFailure = opts?.rejectOnFailure === true;
  const cacheKey = `${agentId}\0${opts.preparedOnly ? "prepared" : "exact"}`;
  const preparedCacheKey = `${agentId}\0prepared`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  // Abort is synchronous, but cache cleanup runs in a promise reaction. A
  // replacement during that gap must not inherit the retired producer/cooldown.
  const pendingRequestAborted = cached?.inFlight?.controller?.signal.aborted === true;
  const refresh =
    opts.refresh === true ||
    (opts.refreshIfDue === true &&
      (pendingRequestAborted || (cached?.refreshEligibleAt ?? 0) <= now));
  const nextRefreshEligibleAt = refresh
    ? now + MODEL_CATALOG_REFRESH_COOLDOWN_MS
    : cached?.refreshEligibleAt;
  const refreshCooldownActive =
    opts.refreshIfDue === true && (cached?.refreshEligibleAt ?? 0) > now;
  if (
    opts.refreshIfDue === true &&
    cached?.inFlight &&
    !pendingRequestAborted &&
    cached.inFlightRefresh === true &&
    cached.inFlightRejects === rejectOnFailure
  ) {
    return await subscribeToModelCatalogRequest(cached.inFlight, opts.signal);
  }
  if (!refresh && cached?.result && (cached.expiresAt > now || refreshCooldownActive)) {
    return cached.result;
  }
  if (
    cached?.inFlight &&
    !pendingRequestAborted &&
    cached.inFlightRejects === rejectOnFailure &&
    (!refresh || cached.inFlightRefresh === true)
  ) {
    return await subscribeToModelCatalogRequest(cached.inFlight, opts.signal);
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const controller = opts.signal ? new AbortController() : undefined;
  const inFlight: ModelCatalogPendingRequest = {
    controller,
    subscribers: new Set(),
    promise: requestModels(
      client,
      cached?.result,
      agentId,
      opts.preparedOnly === true,
      refresh,
      rejectOnFailure,
      controller?.signal,
    )
      .then((result) => {
        const latest = cache.get(cacheKey);
        if (modelCatalogCache.get(client) === cache && latest?.inFlight === inFlight) {
          const refreshEligibleAt = refresh
            ? result.fresh
              ? Date.now() + MODEL_CATALOG_REFRESH_COOLDOWN_MS
              : undefined
            : nextRefreshEligibleAt;
          const entry = {
            expiresAt: result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
            ...(refreshEligibleAt ? { refreshEligibleAt } : {}),
            result: result.value,
          };
          cache.set(cacheKey, entry);
          if (result.fresh && opts.preparedOnly !== true) {
            // An exact catalog supersedes the prepared projection. Reusing it for
            // automatic reads prevents route re-entry from restoring stale data.
            cache.set(preparedCacheKey, entry);
            // Discovery changes prepared metadata, including session-locked projections.
            invalidateChatMetadataStore(client, { agentId });
          }
        }
        return result.value;
      })
      .catch((error: unknown) => {
        const latest = cache.get(cacheKey);
        if (refresh && latest?.inFlight === inFlight) {
          delete latest.refreshEligibleAt;
        }
        throw error;
      })
      .finally(() => {
        const latest = cache.get(cacheKey);
        if (latest?.inFlight === inFlight) {
          delete latest.inFlight;
        }
      }),
  };
  cache.set(cacheKey, {
    expiresAt: cached?.expiresAt ?? 0,
    ...(nextRefreshEligibleAt ? { refreshEligibleAt: nextRefreshEligibleAt } : {}),
    result: cached?.result ?? { models: [] },
    inFlight,
    inFlightRejects: rejectOnFailure,
    ...(refresh ? { inFlightRefresh: true } : {}),
  });
  return await subscribeToModelCatalogRequest(inFlight, opts.signal);
}

async function subscribeToModelCatalogRequest(
  pending: ModelCatalogPendingRequest,
  signal: AbortSignal | undefined,
): Promise<ModelCatalogResult> {
  const subscriber = {};
  pending.subscribers.add(subscriber);
  if (!signal) {
    try {
      return await pending.promise;
    } finally {
      pending.subscribers.delete(subscriber);
    }
  }

  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    pending.subscribers.delete(subscriber);
    // The request is shared: one retired page must not cancel another active
    // consumer, while the final subscriber should stop the Gateway request.
    if (pending.subscribers.size === 0) {
      pending.controller?.abort(signal.reason);
    }
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([pending.promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    pending.subscribers.delete(subscriber);
  }
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogResult | undefined,
  agentId: string,
  preparedOnly: boolean,
  refresh: boolean,
  rejectOnFailure: boolean,
  signal: AbortSignal | undefined,
): Promise<{ value: ModelCatalogResult; fresh: boolean }> {
  try {
    const params = {
      view: "configured",
      agentId,
      ...(preparedOnly ? { preparedOnly: true } : {}),
      ...(refresh ? { refresh: true } : {}),
    };
    const result = signal
      ? await client.request<ModelCatalogResult>("models.list", params, { signal })
      : await client.request<ModelCatalogResult>("models.list", params);
    return { value: result, fresh: true };
  } catch (error) {
    if (rejectOnFailure) {
      throw error;
    }
    // Failed loads fall back without extending the TTL so the next call retries.
    return { value: fallback ?? { models: [] }, fresh: false };
  }
}
