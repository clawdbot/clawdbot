// Control UI model metadata boundary.
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { retryGatewayStartupRequest } from "../gateway-startup-retry.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
// A picker open is an operator signal to revalidate, but full provider discovery can be slow.
const MODEL_CATALOG_REFRESH_COOLDOWN_MS = 5 * 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  requestGeneration?: number;
  refreshEligibleAt?: number;
  models: ModelCatalogEntry[];
  source: "exact" | "prepared" | "ready";
  inFlight?: Promise<ModelCatalogEntry[]>;
  inFlightRefresh?: boolean;
  inFlightRejects?: boolean;
  revalidationPending?: Promise<ModelCatalogEntry[]>;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, Map<string, ModelCatalogCacheEntry>>();

function modelCatalogCacheFor(client: GatewayBrowserClient): Map<string, ModelCatalogCacheEntry> {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = new Map();
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

function modelCatalogCacheKey(
  agentId: string,
  preparedOnly: boolean,
  waitForRuntimeDiscovery = false,
): string {
  // Readiness-confirmed catalogs are a separate authority: neither an exact
  // read nor an ordinary prepared snapshot proves post-ready publication.
  const mode = preparedOnly ? (waitForRuntimeDiscovery ? "ready" : "prepared") : "exact";
  return `${agentId}\0${mode}`;
}

type LoadModelsOptions = {
  agentId: string;
  preparedOnly?: boolean;
  waitForRuntimeDiscovery?: boolean;
  /** Bypass the Control UI cache without replacing Gateway's completed catalog generation. */
  revalidate?: boolean;
  refresh?: boolean;
  refreshIfDue?: boolean;
  rejectOnFailure?: boolean;
  requestTimeoutMs?: number;
};

export async function loadModels(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions,
): Promise<ModelCatalogEntry[]> {
  const cache = modelCatalogCacheFor(client);
  const agentId = opts.agentId.trim();
  const rejectOnFailure = opts?.rejectOnFailure === true;
  const cacheKey = modelCatalogCacheKey(
    agentId,
    opts.preparedOnly === true,
    opts.waitForRuntimeDiscovery === true,
  );
  const preparedCacheKey = modelCatalogCacheKey(agentId, true);
  const exactCacheKey = modelCatalogCacheKey(agentId, false);
  const cached = cache.get(cacheKey);
  const now = Date.now();
  const refresh =
    opts.refresh === true ||
    (opts.refreshIfDue === true && (cached?.refreshEligibleAt ?? 0) <= now);
  const nextRefreshEligibleAt = refresh
    ? now + MODEL_CATALOG_REFRESH_COOLDOWN_MS
    : cached?.refreshEligibleAt;
  const refreshCooldownActive =
    opts.refreshIfDue === true && (cached?.refreshEligibleAt ?? 0) > now;
  if (
    opts.refreshIfDue === true &&
    cached?.inFlight &&
    cached.inFlightRefresh === true &&
    cached.inFlightRejects === rejectOnFailure
  ) {
    return cached.inFlight;
  }
  if (
    !opts.revalidate &&
    !refresh &&
    cached?.models &&
    (cached.expiresAt > now || refreshCooldownActive)
  ) {
    return cached.models;
  }
  if (
    cached?.inFlight &&
    cached.inFlightRejects === rejectOnFailure &&
    (!refresh || cached.inFlightRefresh === true)
  ) {
    return cached.inFlight;
  }
  const requestGeneration =
    Math.max(
      cache.get(preparedCacheKey)?.requestGeneration ?? 0,
      cache.get(exactCacheKey)?.requestGeneration ?? 0,
    ) + 1;
  // Per-key request identity and the cross-key generation prevent an older
  // response from clobbering a later prepared or exact catalog.
  const inFlight: Promise<ModelCatalogEntry[]> = requestModels(
    client,
    cached?.models,
    agentId,
    opts.preparedOnly === true,
    opts.waitForRuntimeDiscovery === true,
    refresh,
    rejectOnFailure,
    opts.requestTimeoutMs,
  )
    .then((result) => {
      const latest = cache.get(cacheKey);
      // Readiness-confirmed prepared data replaces only an older exact projection.
      if (
        opts.preparedOnly === true &&
        opts.waitForRuntimeDiscovery !== true &&
        latest &&
        latest.source !== "prepared" &&
        latest.expiresAt > Date.now()
      ) {
        return latest.models;
      }
      if (!latest || latest.inFlight === inFlight) {
        const refreshEligibleAt = refresh
          ? result.fresh
            ? Date.now() + MODEL_CATALOG_REFRESH_COOLDOWN_MS
            : undefined
          : nextRefreshEligibleAt;
        const entry: ModelCatalogCacheEntry = {
          ...latest,
          expiresAt: result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
          requestGeneration,
          models: result.models,
          source:
            opts.preparedOnly !== true
              ? "exact"
              : opts.waitForRuntimeDiscovery === true
                ? "ready"
                : "prepared",
        };
        if (refreshEligibleAt === undefined) {
          delete entry.refreshEligibleAt;
        } else {
          entry.refreshEligibleAt = refreshEligibleAt;
        }
        cache.set(cacheKey, entry);
        if (result.fresh && opts.preparedOnly === true && opts.waitForRuntimeDiscovery === true) {
          const prepared = cache.get(preparedCacheKey);
          cache.set(preparedCacheKey, {
            expiresAt: entry.expiresAt,
            requestGeneration,
            models: entry.models,
            source: "ready",
            ...(prepared?.revalidationPending
              ? { revalidationPending: prepared.revalidationPending }
              : {}),
          });
        } else if (result.fresh && opts.preparedOnly !== true) {
          // An exact catalog supersedes the prepared projection. Reusing it for
          // automatic reads prevents route re-entry or an older prepared request
          // from restoring stale data.
          const prepared = cache.get(preparedCacheKey);
          if (prepared?.source !== "ready") {
            cache.set(preparedCacheKey, {
              expiresAt: entry.expiresAt,
              requestGeneration,
              ...(entry.refreshEligibleAt ? { refreshEligibleAt: entry.refreshEligibleAt } : {}),
              models: entry.models,
              source: "exact",
              ...(prepared?.revalidationPending
                ? { revalidationPending: prepared.revalidationPending }
                : {}),
            });
          }
        }
      }
      return result.models;
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
    });
  cache.set(cacheKey, {
    ...cached,
    expiresAt: cached?.expiresAt ?? 0,
    requestGeneration,
    ...(nextRefreshEligibleAt ? { refreshEligibleAt: nextRefreshEligibleAt } : {}),
    models: cached?.models ?? [],
    source: cached?.source ?? (opts.preparedOnly === true ? "prepared" : "exact"),
    inFlight,
    inFlightRejects: rejectOnFailure,
    ...(refresh ? { inFlightRefresh: true } : {}),
  });
  return inFlight;
}

export function revalidateModels(
  client: GatewayBrowserClient,
  opts: Pick<LoadModelsOptions, "agentId" | "preparedOnly" | "waitForRuntimeDiscovery"> & {
    startupRetryWindowMs?: number;
  },
): Promise<ModelCatalogEntry[]> {
  const agentId = opts.agentId.trim();
  const preparedOnly = opts.preparedOnly === true;
  const cacheKey = modelCatalogCacheKey(
    agentId,
    preparedOnly,
    opts.waitForRuntimeDiscovery === true,
  );
  const cache = modelCatalogCacheFor(client);
  const cached = cache.get(cacheKey);
  if (cached?.revalidationPending) {
    return cached.revalidationPending;
  }

  const request = (requestTimeoutMs?: number) =>
    loadModels(client, {
      agentId,
      ...(preparedOnly ? { preparedOnly: true } : {}),
      ...(opts.waitForRuntimeDiscovery ? { waitForRuntimeDiscovery: true } : {}),
      revalidate: true,
      rejectOnFailure: true,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    });
  const startupRetryWindowMs = opts.startupRetryWindowMs;
  const revalidationPending =
    startupRetryWindowMs === undefined
      ? request()
      : retryGatewayStartupRequest({
          retryWindowMs: startupRetryWindowMs,
          request: (remainingMs) =>
            request(Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remainingMs)),
          requestFailure: (error) =>
            new Error("New-session model catalog request failed", { cause: error }),
          retryDeadlineMessage: "New-session model catalog retry deadline elapsed",
        });
  cache.set(cacheKey, {
    ...(cache.get(cacheKey) ??
      cached ?? {
        expiresAt: 0,
        models: [],
        source: preparedOnly ? "prepared" : "exact",
      }),
    revalidationPending,
  });
  return revalidationPending.finally(() => {
    const latest = cache.get(cacheKey);
    if (latest?.revalidationPending === revalidationPending) {
      delete latest.revalidationPending;
    }
  });
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogEntry[] | undefined,
  agentId: string,
  preparedOnly: boolean,
  waitForRuntimeDiscovery: boolean,
  refresh: boolean,
  rejectOnFailure: boolean,
  requestTimeoutMs: number | undefined,
): Promise<{ models: ModelCatalogEntry[]; fresh: boolean }> {
  try {
    const params = {
      view: "configured",
      agentId,
      ...(preparedOnly ? { preparedOnly: true } : {}),
      ...(waitForRuntimeDiscovery ? { waitForRuntimeDiscovery: true } : {}),
      ...(refresh ? { refresh: true } : {}),
    };
    const result = await (requestTimeoutMs === undefined
      ? client.request<{ models: ModelCatalogEntry[] }>("models.list", params)
      : client.request<{ models: ModelCatalogEntry[] }>("models.list", params, {
          timeoutMs: requestTimeoutMs,
        }));
    return { models: result?.models ?? [], fresh: true };
  } catch (error) {
    if (rejectOnFailure) {
      throw error;
    }
    // Failed loads fall back without extending the TTL so the next call retries.
    return { models: fallback ?? [], fresh: false };
  }
}
