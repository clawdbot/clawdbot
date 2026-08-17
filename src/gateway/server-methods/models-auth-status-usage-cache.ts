// Stale-while-revalidate cache for models.authStatus provider usage enrichment.
import {
  ensureAuthProfileStore,
  externalCliDiscoveryForConfigStatus,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
  fingerprintResolvedProviderAuth,
} from "../../agents/execution-auth-binding.js";
import {
  resolveLegacyInheritedAuthAgentId,
  resolveLegacyInheritedAuthDir,
} from "../../agents/legacy-inherited-auth-dir.js";
import { resolveEnvApiKey } from "../../agents/model-auth-env.js";
import { resolveUsableCustomProviderApiKey } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { listProviderUsagePluginDescriptors } from "../../plugins/provider-runtime.js";
import { formatForLog } from "../ws-log.js";

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

function scopeProviderUsageCredentialKey(
  credentialKey: string,
  providerIds: readonly UsageProviderId[],
): string {
  // models.authStatus fingerprints every direct provider. Scope that evidence to
  // this fetch set so usage.status can share the same credential-bound snapshot.
  try {
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
  configRef: OpenClawConfig;
  credentialKey: string;
  providerIds: UsageProviderId[];
  providerKey: string;
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
  const publishGeneration = cacheGeneration;
  const promise = loadProviderUsageSummary({
    providers: params.providerIds,
    agentDir: params.agentDir,
    config: params.configRef,
    timeoutMs: 3500,
  })
    .then((usage) => {
      if (
        publishGeneration === cacheGeneration &&
        usageRefreshByAgentId.get(params.agentId) === refresh
      ) {
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
      // Usage is auxiliary and stale data remains valid. Keep failures visible
      // without delaying fresh auth-health responses.
      log.debug(
        `usage refresh failed: providers=${params.providerIds.join(",")} error=${formatForLog(err)}`,
      );
      throw err;
    })
    .finally(() => {
      if (usageRefreshByAgentId.get(params.agentId) === refresh) {
        usageRefreshByAgentId.delete(params.agentId);
      }
    });
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
  configRef: OpenClawConfig;
  credentialKey: string;
  forceRefresh?: boolean;
  providerIds: UsageProviderId[];
  now: number;
};

function resolveProviderUsageCacheRead(params: ProviderUsageCacheParams) {
  const providerIds = params.providerIds.toSorted();
  const providerKey = providerUsageCacheKey(providerIds);
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
      configRef: params.configRef,
      credentialKey,
      providerIds,
      providerKey,
    }).catch(() => {});
  }
  return matching?.usageByProvider ?? new Map();
}

/** Returns cached provider usage, awaiting only a cold miss and refreshing stale data in place. */
async function loadProviderUsageSummaryStaleWhileRevalidate(
  params: ProviderUsageCacheParams,
): Promise<UsageSummary> {
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
    configRef: params.configRef,
    credentialKey,
    providerIds,
    providerKey,
  });
  if (matching) {
    void refresh.catch(() => {});
    return matching.summary;
  }
  return await refresh;
}

/** Shares the models.authStatus cache contract with the unscoped usage.status RPC. */
export async function loadUsageStatusStaleWhileRevalidate(params: {
  config: OpenClawConfig;
  now?: number;
}): Promise<UsageSummary> {
  const agentId = resolveLegacyInheritedAuthAgentId(params.config);
  const agentDir = resolveLegacyInheritedAuthDir(params.config);
  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryForConfigStatus({ cfg: params.config }),
  });
  const providerIds = listProviderUsagePluginDescriptors({
    config: params.config,
    env: process.env,
  }).map((descriptor) => descriptor.provider);
  const directApiKeys = new Map<
    string,
    { source: "config" | "env"; envVar?: string } | undefined
  >();
  for (const provider of providerIds) {
    const resolved =
      resolveUsableCustomProviderApiKey({
        cfg: params.config,
        provider,
        env: process.env,
      }) ?? resolveEnvApiKey(provider, process.env, { config: params.config });
    if (!resolved) {
      continue;
    }
    const envVar = resolved.source.match(/^(?:shell env|env): ([A-Z][A-Z0-9_]*)$/u)?.[1];
    directApiKeys.set(provider, envVar ? { source: "env", envVar } : { source: "config" });
  }
  return await loadProviderUsageSummaryStaleWhileRevalidate({
    agentId,
    agentDir,
    configRef: params.config,
    credentialKey: fingerprintProviderUsageCredentials({
      cfg: params.config,
      directApiKeys,
      store,
    }),
    providerIds,
    now: params.now ?? Date.now(),
  });
}
