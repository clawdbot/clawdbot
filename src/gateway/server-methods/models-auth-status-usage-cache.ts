// Stale-while-revalidate cache for models.authStatus provider usage enrichment.
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  | "windows"
  | "summary"
  | "plan"
  | "billing"
  | "costHistory"
  | "accountEmail"
  | "error"
  | "usageScope"
> & { providerId: UsageProviderId; refreshedAt: number };

type UsageCacheRead = {
  usageByProvider: Map<string, ProviderUsageStatus>;
  refreshPending: boolean;
};

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
  ownerToken: object;
  agentDir: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerKey: string;
  promise: Promise<UsageSummary>;
};

const usageCacheByAgentId = new Map<string, ProviderUsageCacheEntry>();
const usageRefreshByAgentId = new Map<string, ProviderUsageRefresh>();
let cacheGeneration = 0;

export function clearModelAuthStatusUsageCache(): void {
  cacheGeneration += 1;
  usageCacheByAgentId.clear();
  usageRefreshByAgentId.clear();
  clearProviderUsageRuntimeSnapshot();
}

function providerUsageCacheKey(providerIds: readonly UsageProviderId[]): string {
  return providerIds.toSorted().join("\0");
}

function scopeProviderUsageCredentialKey(
  credentialKey: string,
  providerIds: readonly UsageProviderId[],
): string {
  // Scope the prepared credential evidence to this fetch set so unrelated
  // provider credentials do not invalidate its snapshot.
  try {
    // Prepared by the provider-usage runtime as an object with a `direct` array.
    // SAFETY: the runtime producer guarantees this shape, and `direct` is re-checked.
    const parsed = JSON.parse(credentialKey) as {
      direct?: Array<[string, string | null]>;
      [key: string]: unknown;
    };
    if (!Array.isArray(parsed.direct)) {
      return credentialKey;
    }
    const providers = new Set(providerIds);
    return JSON.stringify({
      ...parsed,
      direct: parsed.direct.filter(
        ([provider, fingerprint]) => providers.has(provider) && fingerprint !== null,
      ),
    });
  } catch {
    return credentialKey;
  }
}

function mapProviderUsage(usage: Awaited<ReturnType<typeof loadProviderUsageSummary>>) {
  const usageByProvider = new Map<string, ProviderUsageStatus>();
  for (const snap of usage.providers) {
    usageByProvider.set(snap.provider, {
      providerId: snap.provider,
      refreshedAt: usage.updatedAt,
      windows: snap.windows,
      ...(snap.usageScope ? { usageScope: snap.usageScope } : {}),
      ...(snap.summary ? { summary: snap.summary } : {}),
      ...(snap.plan ? { plan: snap.plan } : {}),
      ...(snap.billing?.length ? { billing: snap.billing } : {}),
      ...(snap.costHistory ? { costHistory: snap.costHistory } : {}),
      ...(snap.accountEmail ? { accountEmail: snap.accountEmail } : {}),
      ...(snap.error ? { error: snap.error } : {}),
    });
  }
  return usageByProvider;
}

function isTransientUsageTimeout(error: string | undefined): boolean {
  return error === "Timeout" || error === "Refresh queue timeout";
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
    (provider) =>
      isTransientUsageTimeout(provider.error) && lastGoodByProvider.has(provider.provider),
  );
  return {
    ...summary,
    updatedAt: retainedLastGood ? lastGood.updatedAt : summary.updatedAt,
    providers: summary.providers.map((provider) =>
      isTransientUsageTimeout(provider.error)
        ? (lastGoodByProvider.get(provider.provider) ?? provider)
        : provider,
    ),
  };
}

function scheduleProviderUsageRefresh(params: {
  cacheOwnerKey: string;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  authProfile?: { provider: UsageProviderId; profileId: string };
  providerOnly?: boolean;
  configRef: OpenClawConfig;
  credentialKey: string;
  providerIds: UsageProviderId[];
  providerKey: string;
  lastGood?: UsageSummary;
}): Promise<UsageSummary> {
  const active = usageRefreshByAgentId.get(params.cacheOwnerKey);
  if (
    active?.agentDir === params.agentDir &&
    active.configRef === params.configRef &&
    active.credentialKey === params.credentialKey &&
    active.providerKey === params.providerKey
  ) {
    return active.promise;
  }
  const publishGeneration = cacheGeneration;
  const ownerToken = {};
  const load = () =>
    loadProviderUsageSummary({
      providers: params.providerIds,
      ...(params.providerOnly ? { providerOnly: true } : {}),
      ...(params.authProfile ? { authProfile: params.authProfile } : {}),
      ...(params.authProfile
        ? {
            isAuthProfileCurrent: () =>
              publishGeneration === cacheGeneration &&
              usageRefreshByAgentId.get(params.cacheOwnerKey)?.ownerToken === ownerToken,
          }
        : {}),
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authStore: params.authStore,
      config: params.configRef,
      timeoutMs: PROVIDER_USAGE_TIMEOUT_MS,
    });
  // Track publication and finalization after the stale-while-revalidate reply.
  const promise = trackAsyncWork(() =>
    load()
      .then((freshUsage) => {
        const usage = retainLastGoodOnTimeout(freshUsage, params.lastGood);
        if (
          publishGeneration === cacheGeneration &&
          usageRefreshByAgentId.get(params.cacheOwnerKey)?.ownerToken === ownerToken
        ) {
          usageCacheByAgentId.set(params.cacheOwnerKey, {
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
        // Usage is auxiliary and stale data remains valid. A failed refresh
        // publishes nothing, so a capable client keeps seeing the incomplete
        // marker and reports it once its retry budget is spent.
        log.debug(
          `usage refresh failed: providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
        );
        throw err;
      })
      .finally(() => {
        if (usageRefreshByAgentId.get(params.cacheOwnerKey)?.ownerToken === ownerToken) {
          usageRefreshByAgentId.delete(params.cacheOwnerKey);
        }
      }),
  );
  const refresh: ProviderUsageRefresh = {
    ownerToken,
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerKey: params.providerKey,
    promise,
  };
  usageRefreshByAgentId.set(params.cacheOwnerKey, refresh);
  return promise;
}

type ProviderUsageCacheParams = {
  agentId: string;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  authProfile?: { provider: UsageProviderId; profileId: string };
  providerOnly?: boolean;
  cacheOwnerKey?: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  coldRead?: "refresh-marker";
  forceRefresh?: boolean;
  providerIds: UsageProviderId[];
  now: number;
};

function resolveProviderUsageCacheRead(params: ProviderUsageCacheParams) {
  const cacheOwnerKey = params.cacheOwnerKey ?? params.agentId;
  const providerIds = params.providerIds.toSorted();
  const providerKey = providerUsageCacheKey(providerIds);
  const credentialKey = params.authProfile
    ? params.credentialKey
    : scopeProviderUsageCredentialKey(params.credentialKey, providerIds);
  const cached = usageCacheByAgentId.get(cacheOwnerKey);
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
  return { cacheOwnerKey, credentialKey, matching, needsRefresh, providerIds, providerKey };
}

function readUsageCacheStaleWhileRevalidate(params: ProviderUsageCacheParams): UsageCacheRead {
  const cacheOwnerKey = params.cacheOwnerKey ?? params.agentId;
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(cacheOwnerKey);
    return { usageByProvider: new Map(), refreshPending: false };
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (needsRefresh) {
    // Never couple the RPC deadline to provider HTTP. A cold call returns auth
    // without usage; stale calls return the last snapshot while one refresh runs.
    void scheduleProviderUsageRefresh({
      cacheOwnerKey,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authStore: params.authStore,
      authProfile: params.authProfile,
      providerOnly: params.providerOnly,
      configRef: params.configRef,
      credentialKey,
      providerIds,
      providerKey,
      lastGood: matching?.summary,
    }).catch(() => {});
  }
  return {
    usageByProvider: matching?.usageByProvider ?? new Map(),
    refreshPending: needsRefresh || usageRefreshByAgentId.has(cacheOwnerKey),
  };
}

export function readProviderUsageStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): UsageCacheRead {
  // A provider-only miss must not hide account usage from the general usage page.
  return readUsageCacheStaleWhileRevalidate({
    ...params,
    providerOnly: true,
    cacheOwnerKey: `${params.agentId}\0provider`,
  });
}

export function readProfileUsageStaleWhileRevalidate(params: {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  configRef: OpenClawConfig;
  profileCredentialKeys: ReadonlyMap<string, string>;
  forceRefresh?: boolean;
  targets: Array<{ profileId: string; providerId: UsageProviderId }>;
  now: number;
}): {
  usageByProfile: Map<string, ProviderUsageStatus>;
  targetProfileIds: Set<string>;
  pendingProfileIds: Set<string>;
  refreshPending: boolean;
} {
  const usageByProfile = new Map<string, ProviderUsageStatus>();
  const pendingProfileIds = new Set<string>();
  const ownerPrefix = `${params.agentId}\0profile\0`;
  const activeOwners = new Set(params.targets.map((target) => `${ownerPrefix}${target.profileId}`));
  const knownOwners = new Set([...usageCacheByAgentId.keys(), ...usageRefreshByAgentId.keys()]);
  for (const ownerKey of knownOwners) {
    if (ownerKey.startsWith(ownerPrefix) && !activeOwners.has(ownerKey)) {
      usageCacheByAgentId.delete(ownerKey);
      usageRefreshByAgentId.delete(ownerKey);
    }
  }
  for (const target of params.targets) {
    const read = readUsageCacheStaleWhileRevalidate({
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      authStore: params.authStore,
      authProfile: { provider: target.providerId, profileId: target.profileId },
      cacheOwnerKey: `${ownerPrefix}${target.profileId}`,
      configRef: params.configRef,
      // Missing profiles still reach the loader's auth handling, but cannot
      // match the non-empty fingerprint of a previously present credential.
      credentialKey: params.profileCredentialKeys.get(target.profileId) ?? "",
      forceRefresh: params.forceRefresh,
      providerIds: [target.providerId],
      now: params.now,
    });
    const usage = read.usageByProvider.get(target.providerId);
    if (usage) {
      usageByProfile.set(target.profileId, usage);
    }
    if (read.refreshPending) {
      pendingProfileIds.add(target.profileId);
    }
  }
  return {
    usageByProfile,
    targetProfileIds: new Set(params.targets.map((target) => target.profileId)),
    pendingProfileIds,
    refreshPending: pendingProfileIds.size > 0,
  };
}

/** Returns cached provider usage while network refreshes run in the background for capable clients. */
async function loadProviderUsageSummaryStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): Promise<UsageSummary> {
  const cacheOwnerKey = params.cacheOwnerKey ?? params.agentId;
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(cacheOwnerKey);
    return { updatedAt: params.now, providers: [] };
  }
  const { credentialKey, matching, needsRefresh, providerIds, providerKey } =
    resolveProviderUsageCacheRead(params);
  if (matching && !needsRefresh) {
    return matching.summary;
  }
  const refresh = scheduleProviderUsageRefresh({
    cacheOwnerKey,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    authStore: params.authStore,
    authProfile: params.authProfile,
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

/** Uses the shared cache machinery for the unscoped usage.status RPC. */
export async function loadUsageStatusStaleWhileRevalidate(params: {
  config: OpenClawConfig;
  coldRead?: "refresh-marker";
  now?: number;
}): Promise<UsageSummary> {
  const snapshot = getProviderUsageRuntimeSnapshot({ config: params.config });
  return await loadProviderUsageSummaryStaleWhileRevalidate({
    agentId: snapshot.agentId,
    agentDir: snapshot.agentDir,
    authStore: snapshot.store,
    configRef: snapshot.configRef,
    credentialKey: snapshot.credentialKey,
    providerIds: snapshot.providerIds,
    coldRead: params.coldRead,
    now: params.now ?? Date.now(),
  });
}
