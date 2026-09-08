// Stale-while-revalidate cache for models.authStatus provider usage enrichment.
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ProviderUsageMetricsListener,
  ProviderUsageMetricsProvider,
  ProviderUsageMetricsRefreshOutcome,
  ProviderUsageMetricsSnapshot,
} from "../../infra/provider-usage-metrics.types.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { PROVIDER_USAGE_TIMEOUT_MS } from "../../infra/provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { formatForLog } from "../ws-log.js";
import {
  clearProviderUsageRuntimeSnapshot,
  getProviderUsageRuntimeSnapshot,
} from "./provider-usage-runtime.js";

const log = createSubsystemLogger("provider-usage-cache");
const USAGE_CACHE_TTL_MS = 60_000;

export type ProviderUsageStatus = Pick<
  ProviderUsageSnapshot,
  "windows" | "summary" | "plan" | "billing" | "accountEmail"
>;

type ProviderUsageCacheEntry = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  refreshedAt: number;
  summary: UsageSummary;
  usageByProvider: Map<string, ProviderUsageStatus>;
};

type ProviderUsageRefresh = {
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  promise: Promise<UsageSummary>;
};

const usageCacheByAgentId = new Map<string, ProviderUsageCacheEntry>();
const usageRefreshByAgentId = new Map<string, ProviderUsageRefresh>();
const usageMetricsByAgentId = new Map<
  string,
  {
    generation: number;
    selectionKey: string;
    providers: Map<string, ProviderUsageMetricsProvider>;
  }
>();
const usageMetricsListenersByAgentId = new Map<string, Set<ProviderUsageMetricsListener>>();
let cacheGeneration = 0;
let usageMetricsGeneration = 0;

const PROVIDER_USAGE_METRICS_REFRESH_INTERVAL_MS = 60_000;
const SAFE_METRIC_DIMENSION_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;

function safeMetricDimension(value: string): string {
  const trimmed = value.trim();
  return SAFE_METRIC_DIMENSION_RE.test(trimmed) ? trimmed : "unknown";
}

function providerUsageRefreshOutcome(
  error: string | undefined,
): ProviderUsageMetricsRefreshOutcome {
  if (!error) {
    return "success";
  }
  const normalized = error.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "timeout";
  }
  if (
    normalized.includes("unauthor") ||
    normalized.includes("forbidden") ||
    normalized.includes("credential") ||
    normalized.includes("oauth") ||
    normalized.includes("token") ||
    /(?:^|\D)(?:401|403)(?:\D|$)/u.test(normalized)
  ) {
    return "auth";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    /(?:^|\D)429(?:\D|$)/u.test(normalized)
  ) {
    return "rate_limit";
  }
  if (
    normalized.includes("billing") ||
    normalized.includes("payment") ||
    normalized.includes("credit") ||
    /(?:^|\D)402(?:\D|$)/u.test(normalized)
  ) {
    return "billing";
  }
  if (
    normalized.includes("malformed") ||
    normalized.includes("parse") ||
    normalized.includes("invalid response") ||
    normalized.includes("unexpected response")
  ) {
    return "format";
  }
  return "unknown";
}

function usageMetricsSnapshot(agentId: string): ProviderUsageMetricsSnapshot {
  const state = usageMetricsByAgentId.get(agentId);
  return {
    generation: state?.generation ?? usageMetricsGeneration,
    providers: [...(state?.providers.values() ?? [])].toSorted((left, right) =>
      left.provider.localeCompare(right.provider),
    ),
  };
}

function publishUsageMetrics(agentId: string): void {
  const listeners = usageMetricsListenersByAgentId.get(agentId);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const snapshot = usageMetricsSnapshot(agentId);
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (err) {
      log.debug(`provider usage metrics listener failed: ${formatForLog(err)}`);
    }
  }
}

function reconcileUsageMetricsSelection(params: {
  agentId: string;
  credentialKey: string;
  providerKey: string;
}): void {
  const selectionKey = `${params.credentialKey}\0${params.providerKey}`;
  if (usageMetricsByAgentId.get(params.agentId)?.selectionKey === selectionKey) {
    return;
  }
  usageMetricsGeneration += 1;
  usageMetricsByAgentId.set(params.agentId, {
    generation: usageMetricsGeneration,
    selectionKey,
    providers: new Map(),
  });
  // Selection changes withdraw prior allowance series until the new owner succeeds.
  publishUsageMetrics(params.agentId);
}

function recordProviderUsageMetricsRefresh(params: {
  agentId: string;
  attemptAt: number;
  credentialKey: string;
  error?: unknown;
  providerIds: readonly UsageProviderId[];
  providerKey: string;
  summary?: UsageSummary;
}): void {
  const state = usageMetricsByAgentId.get(params.agentId);
  if (!state || state.selectionKey !== `${params.credentialKey}\0${params.providerKey}`) {
    return;
  }
  const snapshots = new Map(
    (params.summary?.providers ?? []).map((provider) => [provider.provider, provider]),
  );
  const completedAt = Date.now();
  for (const providerId of params.providerIds) {
    const provider = safeMetricDimension(providerId);
    const snapshot = snapshots.get(providerId);
    const outcome = snapshot
      ? providerUsageRefreshOutcome(snapshot.error)
      : params.error
        ? providerUsageRefreshOutcome(formatForLog(params.error))
        : "unknown";
    const previous = state.providers.get(provider);
    const succeeded = snapshot !== undefined && outcome === "success";
    state.providers.set(provider, {
      provider,
      windows: succeeded
        ? snapshot.windows.map((window) =>
            window.resetAt === undefined
              ? {
                  window: safeMetricDimension(window.label),
                  usedRatio: Math.min(1, Math.max(0, window.usedPercent / 100)),
                }
              : {
                  window: safeMetricDimension(window.label),
                  usedRatio: Math.min(1, Math.max(0, window.usedPercent / 100)),
                  resetTimestampSeconds: window.resetAt / 1000,
                },
          )
        : (previous?.windows ?? []),
      lastAttemptTimestampSeconds: params.attemptAt / 1000,
      ...(succeeded
        ? { lastSuccessTimestampSeconds: completedAt / 1000 }
        : previous?.lastSuccessTimestampSeconds !== undefined
          ? { lastSuccessTimestampSeconds: previous.lastSuccessTimestampSeconds }
          : {}),
      refreshSuccess: succeeded,
      refreshOutcome: outcome,
    });
  }
  publishUsageMetrics(params.agentId);
}

export function clearModelAuthStatusUsageCache(): void {
  cacheGeneration += 1;
  usageCacheByAgentId.clear();
  usageRefreshByAgentId.clear();
  usageMetricsGeneration += 1;
  for (const [agentId] of usageMetricsByAgentId) {
    usageMetricsByAgentId.delete(agentId);
    publishUsageMetrics(agentId);
  }
  clearProviderUsageRuntimeSnapshot();
}

function scopeProviderUsageCredentialKey(
  credentialKey: string,
  providerIds: readonly UsageProviderId[],
): string {
  // models.authStatus fingerprints every direct provider. Scope that evidence to
  // this fetch set so usage.status can share the same credential-bound snapshot.
  // SAFETY: fingerprintProviderUsageCredentials always serializes this shape.
  const parsed = JSON.parse(credentialKey) as {
    direct: Array<[string, string | null]>;
    [key: string]: unknown;
  };
  const providers = new Set(providerIds);
  return JSON.stringify({
    ...parsed,
    direct: parsed.direct.filter(
      ([provider, fingerprint]) => providers.has(provider) && fingerprint !== null,
    ),
  });
}

function mapProviderUsage(usage: Awaited<ReturnType<typeof loadProviderUsageSummary>>) {
  const usageByProvider = new Map<string, ProviderUsageStatus>();
  for (const snap of usage.providers) {
    usageByProvider.set(snap.provider, {
      windows: snap.windows,
      ...(snap.summary ? { summary: snap.summary } : {}),
      ...(snap.plan ? { plan: snap.plan } : {}),
      ...(snap.billing?.length ? { billing: snap.billing } : {}),
      ...(snap.accountEmail ? { accountEmail: snap.accountEmail } : {}),
    });
  }
  return usageByProvider;
}

function retainLastGoodOnTimeout(
  summary: UsageSummary,
  lastGood: UsageSummary | undefined,
): UsageSummary {
  if (!lastGood) {
    return summary;
  }
  const lastGoodByProvider = new Map(
    lastGood.providers
      .filter((provider) => provider.error === undefined)
      .map((provider) => [provider.provider, provider]),
  );
  const retainedLastGood = summary.providers.some(
    (provider) => provider.error === "Timeout" && lastGoodByProvider.has(provider.provider),
  );
  return {
    ...summary,
    updatedAt: retainedLastGood ? lastGood.updatedAt : summary.updatedAt,
    providers: summary.providers.map((provider) =>
      provider.error === "Timeout"
        ? (lastGoodByProvider.get(provider.provider) ?? provider)
        : provider,
    ),
  };
}

function scheduleProviderUsageRefresh(params: {
  agentId: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerIds: UsageProviderId[];
  providerKey: string;
  lastGood?: UsageSummary;
}): Promise<UsageSummary> {
  const active = usageRefreshByAgentId.get(params.agentId);
  if (
    active?.agentDir === params.agentDir &&
    active.configRef === params.configRef &&
    active.credentialKey === params.credentialKey &&
    active.providerKey === params.providerKey
  ) {
    return active.promise;
  }
  reconcileUsageMetricsSelection(params);
  const attemptAt = Date.now();
  const publishGeneration = cacheGeneration;
  // SWR replies and invalidation must retain publication and finalization ownership.
  const promise = trackAsyncWork(() =>
    loadProviderUsageSummary({
      providers: params.providerIds,
      agentDir: params.agentDir,
      authStore: params.authStore,
      config: params.configRef,
      timeoutMs: PROVIDER_USAGE_TIMEOUT_MS,
    })
      .then((freshUsage) => {
        const usage = retainLastGoodOnTimeout(freshUsage, params.lastGood);
        if (
          publishGeneration === cacheGeneration &&
          usageRefreshByAgentId.get(params.agentId) === refresh
        ) {
          recordProviderUsageMetricsRefresh({
            agentId: params.agentId,
            attemptAt,
            credentialKey: params.credentialKey,
            providerIds: params.providerIds,
            providerKey: params.providerKey,
            summary: freshUsage,
          });
          usageCacheByAgentId.set(params.agentId, {
            agentDir: params.agentDir,
            configRef: params.configRef,
            credentialKey: params.credentialKey,
            providerKey: params.providerKey,
            refreshedAt: Date.now(),
            summary: usage,
            usageByProvider: mapProviderUsage(usage),
          });
        }
        return usage;
      })
      .catch((err: unknown) => {
        if (
          publishGeneration === cacheGeneration &&
          usageRefreshByAgentId.get(params.agentId) === refresh
        ) {
          recordProviderUsageMetricsRefresh({
            agentId: params.agentId,
            attemptAt,
            credentialKey: params.credentialKey,
            error: err,
            providerIds: params.providerIds,
            providerKey: params.providerKey,
          });
        }
        // Usage is auxiliary and stale data remains valid. A failed refresh
        // publishes nothing, so a capable client keeps seeing the incomplete
        // marker and reports it once its retry budget is spent.
        log.debug(
          `usage refresh failed: providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
        );
        throw err;
      })
      .finally(() => {
        if (usageRefreshByAgentId.get(params.agentId) === refresh) {
          usageRefreshByAgentId.delete(params.agentId);
        }
      }),
  );
  const refresh: ProviderUsageRefresh = {
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerKey: params.providerKey,
    promise,
  };
  usageRefreshByAgentId.set(params.agentId, refresh);
  return promise;
}

type ProviderUsageCacheParams = {
  agentId: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  configRef: OpenClawConfig;
  credentialKey: string;
  coldRead?: "refresh-marker";
  forceRefresh?: boolean;
  providerIds: UsageProviderId[];
  now: number;
};

function resolveProviderUsageCacheRead(params: ProviderUsageCacheParams) {
  const providerIds = params.providerIds.toSorted();
  const providerKey = providerIds.join("\0");
  const credentialKey = scopeProviderUsageCredentialKey(params.credentialKey, providerIds);
  const cached = usageCacheByAgentId.get(params.agentId);
  const matching =
    cached?.agentDir === params.agentDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === credentialKey &&
    cached.providerKey === providerKey
      ? cached
      : undefined;
  const needsRefresh =
    params.forceRefresh === true ||
    !matching ||
    params.now - matching.refreshedAt >= USAGE_CACHE_TTL_MS;
  return { credentialKey, matching, needsRefresh, providerIds, providerKey };
}

export function readProviderUsageStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): Map<string, ProviderUsageStatus> {
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return new Map();
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (needsRefresh) {
    // Never couple the RPC deadline to provider HTTP. A cold call returns auth
    // without usage; stale calls return the last snapshot while one refresh runs.
    void scheduleProviderUsageRefresh({
      agentId: params.agentId,
      agentDir: params.agentDir,
      authStore: params.authStore,
      configRef: params.configRef,
      credentialKey,
      providerIds,
      providerKey,
      lastGood: matching?.summary,
    }).catch(() => {});
  }
  return matching?.usageByProvider ?? new Map();
}

/** Shares the models.authStatus cache contract with the unscoped usage.status RPC. */
export async function loadUsageStatusStaleWhileRevalidate(options: {
  config: OpenClawConfig;
  coldRead?: "refresh-marker";
  now?: number;
}): Promise<UsageSummary> {
  const snapshot = getProviderUsageRuntimeSnapshot({ config: options.config });
  const params: ProviderUsageCacheParams = {
    agentId: snapshot.agentId,
    agentDir: snapshot.agentDir,
    authStore: snapshot.store,
    configRef: snapshot.configRef,
    credentialKey: snapshot.credentialKey,
    providerIds: snapshot.providerIds,
    coldRead: options.coldRead,
    now: options.now ?? Date.now(),
  };
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return { updatedAt: params.now, providers: [] };
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (matching && !needsRefresh) {
    return matching.summary;
  }
  const refresh = scheduleProviderUsageRefresh({
    agentId: params.agentId,
    agentDir: params.agentDir,
    authStore: params.authStore,
    configRef: params.configRef,
    credentialKey,
    providerIds,
    providerKey,
    lastGood: matching?.summary,
  });
  if (matching) {
    void refresh.catch(() => {});
    return matching.summary;
  }
  if (params.coldRead !== "refresh-marker") {
    return await refresh;
  }
  void refresh.catch(() => {});
  return { updatedAt: params.now, providers: [], refreshing: true };
}
/**
 * Observes privacy-safe allowance snapshots owned by the default-agent usage cache.
 * The returned lease schedules refreshes; listeners and Prometheus scrapes never fetch providers.
 */
export function observeProviderUsageMetrics(params: {
  getConfig: () => OpenClawConfig;
  listener: ProviderUsageMetricsListener;
  refreshIntervalMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let agentId: string | undefined;

  const removeListener = (targetAgentId: string | undefined) => {
    if (!targetAgentId) {
      return;
    }
    const listeners = usageMetricsListenersByAgentId.get(targetAgentId);
    listeners?.delete(params.listener);
    if (listeners?.size === 0) {
      usageMetricsListenersByAgentId.delete(targetAgentId);
    }
  };

  const refresh = async () => {
    try {
      const snapshot = getProviderUsageRuntimeSnapshot({ config: params.getConfig() });
      if (agentId !== snapshot.agentId) {
        removeListener(agentId);
      }
      agentId = snapshot.agentId;
      const { credentialKey, matching, providerIds, providerKey } = resolveProviderUsageCacheRead({
        agentId,
        agentDir: snapshot.agentDir,
        authStore: snapshot.store,
        configRef: snapshot.configRef,
        credentialKey: snapshot.credentialKey,
        providerIds: snapshot.providerIds,
        forceRefresh: true,
        now: Date.now(),
      });
      reconcileUsageMetricsSelection({ agentId, credentialKey, providerKey });
      let listeners = usageMetricsListenersByAgentId.get(agentId);
      if (!listeners) {
        listeners = new Set();
        usageMetricsListenersByAgentId.set(agentId, listeners);
      }
      listeners.add(params.listener);
      publishUsageMetrics(agentId);
      await scheduleProviderUsageRefresh({
        agentId,
        agentDir: snapshot.agentDir,
        authStore: snapshot.store,
        configRef: snapshot.configRef,
        credentialKey,
        providerIds,
        providerKey,
        lastGood: matching?.summary,
      });
    } catch (err) {
      log.debug(`provider usage metrics refresh failed: ${formatForLog(err)}`);
    } finally {
      if (!stopped) {
        timer = setTimeout(
          () => void refresh(),
          params.refreshIntervalMs ?? PROVIDER_USAGE_METRICS_REFRESH_INTERVAL_MS,
        );
        timer.unref?.();
      }
    }
  };

  void refresh();
  return () => {
    stopped = true;
    clearTimeout(timer);
    removeListener(agentId);
  };
}
