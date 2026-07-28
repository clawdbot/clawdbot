// Stale-while-revalidate cache for models.authStatus provider usage enrichment.
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
  fingerprintResolvedProviderAuth,
} from "../../agents/execution-auth-binding.js";
import { resolveUsableCustomProviderApiKey } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import type { ProviderUsageSnapshot, UsageProviderId } from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatForLog } from "../ws-log.js";

const log = createSubsystemLogger("models-auth-status");
const USAGE_CACHE_TTL_MS = 60_000;

export type ProviderUsageStatus = Pick<
  ProviderUsageSnapshot,
  "windows" | "summary" | "plan" | "billing" | "accountEmail"
>;

type ProviderUsageCacheEntry = {
  agentDir: string;
  configRef: object;
  credentialKey: string;
  providerKey: string;
  refreshedAt: number;
  usageByProvider: Map<string, ProviderUsageStatus>;
};

type ProviderUsageRefresh = {
  agentDir: string;
  configRef: object;
  credentialKey: string;
  providerKey: string;
};

const usageCacheByAgentId = new Map<string, ProviderUsageCacheEntry>();
const usageRefreshByAgentId = new Map<string, ProviderUsageRefresh>();
let cacheGeneration = 0;

function sortedRecordEntries<T>(value: Record<string, T> | undefined) {
  return Object.entries(value ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
}

export function fingerprintProviderUsageCredentials(params: {
  cfg: OpenClawConfig;
  directApiKeys: ReadonlyMap<string, { source: "config" | "env"; envVar?: string } | undefined>;
  store: AuthProfileStore;
}): string {
  const profiles = Object.entries(params.store.profiles)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([profileId, credential]) => {
      const fingerprint =
        fingerprintAuthProfileCredential({ profileId, credential }) ??
        fingerprintAuthProfileOwnerShape({ profileId, credential });
      return fingerprint ?? `${profileId}:${credential.type}:${credential.provider}`;
    });
  const direct = [...params.directApiKeys]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([provider, evidence]) => {
      const configured = resolveUsableCustomProviderApiKey({
        cfg: params.cfg,
        provider,
        env: process.env,
      });
      const envValue = evidence?.envVar ? process.env[evidence.envVar]?.trim() : undefined;
      const resolved =
        configured ??
        (envValue ? { apiKey: envValue, source: `env: ${evidence?.envVar}` } : undefined);
      const fingerprint = resolved
        ? fingerprintResolvedProviderAuth({
            apiKey: resolved.apiKey,
            source: resolved.source,
            mode: "api-key",
          })
        : undefined;
      return [provider, fingerprint ?? null];
    });
  // Profile selection can switch accounts without changing the profile set.
  // Include every non-secret selector that resolveAuthProfileOrder consults.
  return JSON.stringify({
    profiles,
    direct,
    order: sortedRecordEntries(params.store.order),
    lastGood: sortedRecordEntries(params.store.lastGood),
    usageStats: sortedRecordEntries(params.store.usageStats),
  });
}

export function clearModelAuthStatusUsageCache(): void {
  cacheGeneration += 1;
  usageCacheByAgentId.clear();
  usageRefreshByAgentId.clear();
}

function providerUsageCacheKey(providerIds: readonly UsageProviderId[]): string {
  return providerIds.toSorted().join("\0");
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

function scheduleProviderUsageRefresh(params: {
  agentId: string;
  agentDir: string;
  configRef: object;
  credentialKey: string;
  providerIds: UsageProviderId[];
  providerKey: string;
}): void {
  const active = usageRefreshByAgentId.get(params.agentId);
  if (
    active?.agentDir === params.agentDir &&
    active.configRef === params.configRef &&
    active.credentialKey === params.credentialKey &&
    active.providerKey === params.providerKey
  ) {
    return;
  }
  const publishGeneration = cacheGeneration;
  const refresh = {
    agentDir: params.agentDir,
    configRef: params.configRef,
    credentialKey: params.credentialKey,
    providerKey: params.providerKey,
  };
  usageRefreshByAgentId.set(params.agentId, refresh);
  void loadProviderUsageSummary({
    providers: params.providerIds,
    agentDir: params.agentDir,
    timeoutMs: 3500,
  })
    .then((usage) => {
      if (
        publishGeneration !== cacheGeneration ||
        usageRefreshByAgentId.get(params.agentId) !== refresh
      ) {
        return;
      }
      usageCacheByAgentId.set(params.agentId, {
        agentDir: params.agentDir,
        configRef: params.configRef,
        credentialKey: params.credentialKey,
        providerKey: params.providerKey,
        refreshedAt: Date.now(),
        usageByProvider: mapProviderUsage(usage),
      });
    })
    .catch((err: unknown) => {
      // Usage is auxiliary and stale data remains valid. Keep failures visible at
      // debug level without delaying or failing the fresh auth-health response.
      log.debug(
        `usage enrichment failed (auth status still returned): providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
      );
    })
    .finally(() => {
      if (usageRefreshByAgentId.get(params.agentId) === refresh) {
        usageRefreshByAgentId.delete(params.agentId);
      }
    });
}

export function readProviderUsageStaleWhileRevalidate(params: {
  agentId: string;
  agentDir: string;
  configRef: object;
  credentialKey: string;
  forceRefresh?: boolean;
  providerIds: UsageProviderId[];
  now: number;
}): Map<string, ProviderUsageStatus> {
  if (params.providerIds.length === 0) {
    usageCacheByAgentId.delete(params.agentId);
    return new Map();
  }
  const providerIds = params.providerIds.toSorted();
  const providerKey = providerUsageCacheKey(providerIds);
  const cached = usageCacheByAgentId.get(params.agentId);
  const matching =
    cached?.agentDir === params.agentDir &&
    cached.configRef === params.configRef &&
    cached.credentialKey === params.credentialKey &&
    cached.providerKey === providerKey
      ? cached
      : undefined;
  if (
    params.forceRefresh === true ||
    !matching ||
    params.now - matching.refreshedAt >= USAGE_CACHE_TTL_MS
  ) {
    // Never couple the RPC deadline to provider HTTP. A cold call returns auth
    // without usage; stale calls return the last snapshot while one refresh runs.
    scheduleProviderUsageRefresh({
      agentId: params.agentId,
      agentDir: params.agentDir,
      configRef: params.configRef,
      credentialKey: params.credentialKey,
      providerIds,
      providerKey,
    });
  }
  return matching?.usageByProvider ?? new Map();
}
