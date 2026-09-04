import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type {
  AuthProfileHealthStatus,
  AuthProviderHealth,
  AuthProviderHealthStatus,
} from "../../agents/auth-health.js";
import { formatRemainingShort } from "../../agents/auth-health.js";
import {
  type AuthProfileStore,
  type RuntimeAuthProfileStore,
  resolveAuthProfileMetadata,
  resolveExplicitAuthOrderSelection,
} from "../../agents/auth-profiles.js";
import {
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
} from "../../agents/model-auth-markers.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { providerUsageLabel, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type { ProviderUsageStatus } from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthExpiry,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
  ModelAuthUsage,
} from "./models-auth-status.types.js";

// UI expiry fields are emitted only when both timestamp and remaining duration
// are valid, keeping profile/provider expiry shapes all-or-nothing.
function buildExpiry(
  remainingMs: number | undefined,
  expiresAt: number | undefined,
): ModelAuthExpiry | undefined {
  const normalizedExpiresAt = asDateTimestampMs(expiresAt);
  if (normalizedExpiresAt === undefined || typeof remainingMs !== "number") {
    return undefined;
  }
  return { at: normalizedExpiresAt, remainingMs, label: formatRemainingShort(remainingMs) };
}

function providerDisplayName(provider: string): string {
  const usageId = resolveUsageProviderId(provider);
  return (usageId ? providerUsageLabel(usageId) : undefined) ?? provider;
}

type ModelAuthStatusRollup = {
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
};

function aggregateProfileStatus(
  profiles: AuthProviderHealth["profiles"],
  now: number,
): ModelAuthStatusRollup {
  const statuses = new Set<AuthProfileHealthStatus>(profiles.map((profile) => profile.status));
  const status = (["expired", "missing", "expiring", "ok", "static"] as const).find((candidate) =>
    statuses.has(candidate),
  );
  const expirable = profiles
    .map((profile) => profile.expiresAt)
    .filter((value): value is number => asDateTimestampMs(value) !== undefined);
  const expiresAt = expirable.length > 0 ? Math.min(...expirable) : undefined;
  return {
    status: status ?? "static",
    expiresAt,
    remainingMs: expiresAt !== undefined ? expiresAt - now : undefined,
  };
}

/** Aggregate the effective refreshable credential status for the dashboard. */
export function aggregateRefreshableAuthStatus(
  provider: AuthProviderHealth,
  now: number = Date.now(),
  expectsOAuth = false,
): ModelAuthStatusRollup {
  const profiles = provider.effectiveProfiles ?? provider.profiles;
  const oauth = profiles.filter((profile) => profile.type === "oauth");
  if (oauth.length > 0) {
    return aggregateProfileStatus(oauth, now);
  }
  const tokens = profiles.filter((profile) => profile.type === "token");
  if (tokens.length > 0) {
    return aggregateProfileStatus(tokens, now);
  }
  if (expectsOAuth) {
    return { status: "missing" };
  }
  return {
    status: provider.status,
    expiresAt: provider.expiresAt,
    remainingMs: provider.remainingMs,
  };
}

function mapUsageStatus(usage: ProviderUsageStatus, includeAccountEmail = true): ModelAuthUsage {
  return {
    providerId: usage.providerId,
    refreshedAt: usage.refreshedAt,
    windows: usage.windows,
    ...(usage.summary ? { summary: usage.summary } : {}),
    ...(usage.plan ? { plan: usage.plan } : {}),
    ...(usage.billing?.length ? { billing: usage.billing } : {}),
    ...(usage.costHistory ? { costHistory: usage.costHistory } : {}),
    ...(includeAccountEmail && usage.accountEmail ? { accountEmail: usage.accountEmail } : {}),
    ...(usage.error ? { error: usage.error } : {}),
  };
}

function mapAuthStatusProfile(params: {
  profile: AuthProviderHealth["profiles"][number];
  config: OpenClawConfig;
  store: AuthProfileStore;
  usageByProfile: Map<string, ProviderUsageStatus>;
  pendingUsageProfileIds: ReadonlySet<string>;
  logoutProfileIds: ReadonlySet<string>;
  configBoundProfileIds: ReadonlySet<string>;
  externalProfileIds: ReadonlySet<string>;
  localProfileIds: ReadonlySet<string>;
  externalCliProfileIds: ReadonlySet<string>;
  includeProfileDetails: boolean;
}): ModelAuthStatusProfile {
  const { profile, config, store } = params;
  const metadata = resolveAuthProfileMetadata({
    cfg: config,
    store,
    profileId: profile.profileId,
  });
  const usage = params.usageByProfile.get(profile.profileId);
  const lastUsedAt = store.usageStats?.[profile.profileId]?.lastUsed;
  return {
    profileId: profile.profileId,
    type: profile.type,
    status: profile.status,
    reasonCode: profile.reasonCode,
    source: params.configBoundProfileIds.has(profile.profileId)
      ? "config"
      : params.externalProfileIds.has(profile.profileId)
        ? "external"
        : params.localProfileIds.has(profile.profileId)
          ? "saved"
          : "inherited",
    expiry: buildExpiry(profile.remainingMs, profile.expiresAt),
    ...(params.externalCliProfileIds.has(profile.profileId) ? { externallyManaged: true } : {}),
    ...(params.includeProfileDetails && metadata.displayName
      ? { displayName: metadata.displayName }
      : {}),
    ...(params.includeProfileDetails && metadata.email ? { email: metadata.email } : {}),
    ...(params.includeProfileDetails && lastUsedAt ? { lastUsedAt } : {}),
    ...(usage ? { usage: mapUsageStatus(usage, params.includeProfileDetails) } : {}),
    ...(params.pendingUsageProfileIds.has(profile.profileId) ? { usageRefreshPending: true } : {}),
    ...((profile.type === "oauth" || profile.type === "token") &&
    params.logoutProfileIds.has(profile.profileId) &&
    !params.configBoundProfileIds.has(profile.profileId)
      ? { logoutSupported: true }
      : {}),
  };
}

export function mapAuthStatusProvider(params: {
  provider: AuthProviderHealth;
  config: OpenClawConfig;
  store: AuthProfileStore;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  usageByProvider: Map<string, ProviderUsageStatus>;
  usageByProfile: Map<string, ProviderUsageStatus>;
  pendingUsageProfileIds: ReadonlySet<string>;
  expectsOAuthSet: Set<string>;
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>;
  logoutProfileIds: ReadonlySet<string>;
  configBoundProfileIds: ReadonlySet<string>;
  externalProfileIds: ReadonlySet<string>;
  externalCliProfileIds: ReadonlySet<string>;
  includeProfileDetails: boolean;
}): ModelAuthStatusProvider {
  const { provider, config, store } = params;
  const providerKey = normalizeProviderId(provider.provider);
  const authProviderKey = resolveProviderIdForAuth(provider.provider, params.authAliasLookupParams);
  const profileOrder = resolveExplicitAuthOrderSelection({
    storeOrder: store.order,
    configuredOrder: config.auth?.order,
    providerKey,
    providerAuthKey: authProviderKey,
  });
  const runtimeStore: RuntimeAuthProfileStore = store;
  const storedOrderKey =
    findNormalizedProviderKey(store.order, authProviderKey) ??
    findNormalizedProviderKey(store.order, providerKey);
  const localOrderStored =
    storedOrderKey !== undefined &&
    runtimeStore.runtimeLocalOrderProviderIds?.includes(storedOrderKey);
  const localProfileIds = new Set(
    runtimeStore.runtimeLocalProfileIds ??
      Object.keys(store.profiles).filter((profileId) => !params.externalProfileIds.has(profileId)),
  );
  const providerOrderLocked = provider.profiles.some((profile) =>
    params.configBoundProfileIds.has(profile.profileId),
  );
  const configuredOrderLocked = profileOrder.order !== undefined && !profileOrder.fromStore;
  const effectiveProfiles = provider.effectiveProfiles ?? provider.profiles;
  const usageProfile =
    effectiveProfiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
    effectiveProfiles.find((profile) => profile.type === "api_key");
  const usageKey = resolveUsageProviderId(provider.provider, {
    credentialType: usageProfile?.type,
  });
  const providerUsage = usageKey ? params.usageByProvider.get(usageKey) : undefined;
  const accountUsage =
    usageKey && usageProfile ? params.usageByProfile.get(usageProfile.profileId) : undefined;
  const usage = providerUsage ?? accountUsage;
  const usageScope = providerUsage ? "provider" : accountUsage ? "account" : undefined;
  const rawRollup = aggregateRefreshableAuthStatus(
    provider,
    Date.now(),
    params.expectsOAuthSet.has(provider.provider),
  );
  const refreshableProfiles = effectiveProfiles.filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  // External CLI access tokens rotate without operator action. Keep their raw
  // profile expiry diagnostic, but do not turn it into a provider login warning.
  const externalCliOwnsOAuthRefresh =
    refreshableProfiles.length > 0 &&
    refreshableProfiles.every(
      (profile) => profile.type === "oauth" && params.externalCliProfileIds.has(profile.profileId),
    );
  const rollup: ModelAuthStatusRollup =
    externalCliOwnsOAuthRefresh &&
    (rawRollup.status === "expired" || rawRollup.status === "expiring")
      ? { status: "ok" }
      : rawRollup;
  const apiKey = params.apiKeys.get(normalizeProviderId(provider.provider));
  const hasRefreshableProfile = provider.profiles.some(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  return {
    provider: provider.provider,
    authProvider: authProviderKey,
    displayName: providerDisplayName(provider.provider),
    status:
      apiKey && !hasRefreshableProfile && rollup.status === "missing" ? "static" : rollup.status,
    expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: provider.profiles.map((profile) =>
      mapAuthStatusProfile({
        profile,
        config,
        store,
        usageByProfile: params.usageByProfile,
        pendingUsageProfileIds: params.pendingUsageProfileIds,
        logoutProfileIds: params.logoutProfileIds,
        configBoundProfileIds: params.configBoundProfileIds,
        externalProfileIds: params.externalProfileIds,
        localProfileIds,
        externalCliProfileIds: params.externalCliProfileIds,
        includeProfileDetails: params.includeProfileDetails,
      }),
    ),
    ...(profileOrder.order !== undefined ? { profileOrder: profileOrder.order } : {}),
    ...(profileOrder.fromStore && localOrderStored ? { profileOrderStored: true } : {}),
    ...(providerOrderLocked
      ? { profileOrderLocked: "provider-config" as const }
      : configuredOrderLocked
        ? { profileOrderLocked: "auth-config" as const }
        : {}),
    ...(apiKey ? { apiKey } : {}),
    usage: usage && usageKey ? mapUsageStatus(usage, params.includeProfileDetails) : undefined,
    ...(usageScope ? { usageScope } : {}),
  };
}

export function resolveConfiguredProviders(
  config: OpenClawConfig,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
): { providers: string[]; expectsOAuth: Set<string> } {
  const providers = new Set<string>();
  const expectsOAuth = new Set<string>();
  for (const [id, provider] of Object.entries(config.models?.providers ?? {})) {
    const normalized = normalizeProviderId(id);
    if (!normalized) {
      continue;
    }
    const rawKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
    const hasApiKey =
      hasConfiguredSecretInput(provider?.apiKey, config.secrets?.defaults) &&
      (rawKey === NON_ENV_SECRETREF_MARKER ||
        !isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false }));
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token" && !hasApiKey) {
      continue;
    }
    if (!apiKeys.has(normalized)) {
      providers.add(normalized);
      if (mode === "oauth") {
        expectsOAuth.add(normalized);
      }
    }
  }
  for (const profile of Object.values(config.auth?.profiles ?? {})) {
    if (
      typeof profile?.provider !== "string" ||
      profile.provider.length === 0 ||
      (profile.mode !== "oauth" && profile.mode !== "token")
    ) {
      continue;
    }
    const normalized = normalizeProviderId(profile.provider);
    if (!normalized || apiKeys.has(normalized)) {
      continue;
    }
    providers.add(normalized);
    if (profile.mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  return { providers: [...providers], expectsOAuth };
}
