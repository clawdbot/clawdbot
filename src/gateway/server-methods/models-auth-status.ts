// Model auth status methods report provider credential health, profile expiry,
// usage windows, cleanup actions, and auth-state refreshes.
import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import {
  type AuthHealthSummary,
  type AuthProfileHealthStatus,
  type AuthProviderHealth,
  type AuthProviderHealthStatus,
  buildAuthHealthSummary,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import {
  type AuthProfileStore,
  type RuntimeAuthProfileStore,
  resolveAuthProfileMetadata,
  resolveExplicitAuthOrderSelection,
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
  removeProviderAuthProfilesWithLock,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import { getRuntimeExternalCliProfileIds } from "../../agents/auth-profiles/runtime-external-profile-references.js";
import {
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
} from "../../agents/model-auth-markers.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { resolveProviderUsageAuthEnvCredentialProviders } from "../../infra/provider-usage.auth.js";
import { providerUsageLabel, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type { UsageProviderId } from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { abortChatRunsForProvider, type ChatAbortOps } from "../chat-abort.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { formatForLog } from "../ws-log.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import { resolveProviderApiKeys } from "./models-auth-status-api-keys.js";
import { resolveConfigBoundProfileIds } from "./models-auth-status-config.js";
import {
  clearModelAuthStatusUsageCache,
  type ProviderUsageStatus,
  readProfileUsageStaleWhileRevalidate,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthExpiry,
  ModelAuthStatusProvider,
  ModelAuthUsage,
  ModelAuthLogoutResult,
  ModelAuthStatusResult,
} from "./models-auth-status.types.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

export type {
  ModelAuthExpiry,
  ModelAuthLogoutResult,
  ModelAuthOrderSetResult,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelProviderCapability,
} from "./models-auth-status.types.js";

const log = createSubsystemLogger("models-auth-status");
type PreparedAuthMetadataLookupParams = ProviderAuthAliasLookupParams & {
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
};

function resolveAuthRefreshScope(cfg: OpenClawConfig): {
  providerIds: string[];
  profileIds?: string[];
} {
  const discovery = externalCliDiscoveryForConfigStatus({ cfg });
  if (discovery.mode !== "scoped") {
    return { providerIds: [] };
  }
  const providerIds = [...(discovery.providerIds ?? [])];
  const profileIds = [...(discovery.profileIds ?? [])];
  return {
    providerIds,
    ...(profileIds.length > 0 ? { profileIds } : {}),
  };
}

/**
 * Invalidate auxiliary usage and prepared provider-auth state after an auth
 * mutation. Auth health itself is rebuilt on every request; only outbound
 * usage enrichment is cached.
 */
export function invalidateModelAuthStatusCache(): void {
  clearModelAuthStatusUsageCache();
  // The prepared provider-auth map (model-provider-auth.ts) was built from
  // the pre-mutation auth state, so it must be invalidated alongside this
  // cache whenever an auth-profile mutation lands (logout, login, token
  // rotation, etc.). Without this, `/models` and pickers keep advertising
  // providers the running gateway can no longer authenticate.
  clearCurrentProviderAuthState();
}

async function refreshModelAuthStatusRuntimeState(): Promise<void> {
  // Durable and CLI auth refresh into the transient prepared owner below. Do not clear the
  // process-wide warmed auth state for a read; mutations still invalidate it explicitly.
  try {
    await refreshActiveProviderAuthRuntimeSnapshot();
  } catch (err) {
    log.warn(`runtime auth snapshot refresh before auth status failed: ${formatForLog(err)}`);
  }
}

function readProviderParam(params: Record<string, unknown>): string | null {
  const raw = params.provider;
  if (typeof raw !== "string") {
    return null;
  }
  const provider = normalizeProviderId(raw);
  return provider || null;
}

type LogoutProfileSelection = { ok: true; profileIds?: string[] } | { ok: false; message: string };

function readLogoutProfileSelection(params: Record<string, unknown>): LogoutProfileSelection {
  if (!("profileIds" in params)) {
    return { ok: true };
  }
  if (!Array.isArray(params.profileIds) || params.profileIds.length === 0) {
    return { ok: false, message: "profileIds must be a non-empty string array" };
  }
  const profileIds: string[] = [];
  for (const value of params.profileIds) {
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, message: "profileIds must be a non-empty string array" };
    }
    const profileId = value.trim();
    if (!profileIds.includes(profileId)) {
      profileIds.push(profileId);
    }
  }
  return { ok: true, profileIds };
}

function createAuthLogoutAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunState: context.chatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

// Auth profiles can be adopted by a provider-specific owner agent dir. Logout
// must remove every owning store or stale profiles reappear on the next status
// read and provider-auth warmup.
async function removeProviderAuthProfilesAcrossOwnerStores(params: {
  provider: string;
  agentDir: string;
  profileIds: string[];
}): Promise<boolean> {
  const ownerAgentDirs = new Set<string | undefined>([params.agentDir]);
  for (const profileId of params.profileIds) {
    ownerAgentDirs.add(
      resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId,
      }),
    );
  }
  for (const ownerAgentDir of ownerAgentDirs) {
    const updatedStore = await removeProviderAuthProfilesWithLock({
      provider: params.provider,
      agentDir: ownerAgentDir,
    });
    if (!updatedStore) {
      return false;
    }
  }
  return true;
}

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
    .map((p) => p.expiresAt)
    .filter((v): v is number => asDateTimestampMs(v) !== undefined);
  const expiresAt = expirable.length > 0 ? Math.min(...expirable) : undefined;
  const remainingMs = expiresAt !== undefined ? expiresAt - now : undefined;
  return { status: status ?? "static", expiresAt, remainingMs };
}

/**
 * Aggregate the effective refreshable credential status for the dashboard.
 * OAuth remains authoritative when present; token credentials are the
 * supported fallback after an OAuth-to-token migration. Explicit auth-order
 * exclusions remain authoritative through `effectiveProfiles`.
 *
 * `expectsOAuth` keeps an API-key-only provider `missing` after config switches
 * to OAuth but login has not completed.
 */
export function aggregateRefreshableAuthStatus(
  prov: AuthProviderHealth,
  now: number = Date.now(),
  expectsOAuth = false,
): ModelAuthStatusRollup {
  const profiles = prov.effectiveProfiles ?? prov.profiles;
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
  return { status: prov.status, expiresAt: prov.expiresAt, remainingMs: prov.remainingMs };
}

function mapUsageStatus(usage: ProviderUsageStatus, includeAccountEmail = true): ModelAuthUsage {
  return includeAccountEmail ? usage : { ...usage, accountEmail: undefined };
}

function mapAuthStatusProvider(params: {
  provider: AuthProviderHealth;
  config: OpenClawConfig;
  store: AuthProfileStore;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  usageByProvider: Map<string, ProviderUsageStatus>;
  usageByProfile: Map<string, ProviderUsageStatus>;
  usageTargetProfileIds: ReadonlySet<string>;
  pendingUsageProfileIds: ReadonlySet<string>;
  expectsOAuthSet: Set<string>;
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>;
  logoutProfileIds: ReadonlySet<string>;
  configBoundProfileIds: ReadonlySet<string>;
  configBoundAuthProviders: ReadonlySet<string>;
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
  const providerOrderLocked = params.configBoundAuthProviders.has(authProviderKey);
  const configuredOrderLocked = profileOrder.order !== undefined && !profileOrder.fromStore;
  const effectiveProfiles = provider.effectiveProfiles ?? provider.profiles;
  // Auth health already resolved credential priority. Missing or pending quota for
  // that account must not substitute a lower-priority account's usage.
  const usageProfile = effectiveProfiles[0];
  const usageKey =
    effectiveProfiles
      .map((profile) => resolveUsageProviderId(provider.provider, { credentialType: profile.type }))
      .find((id) => id !== undefined) ?? resolveUsageProviderId(provider.provider);
  const providerUsage = usageKey ? params.usageByProvider.get(usageKey) : undefined;
  const accountUsage = usageProfile ? params.usageByProfile.get(usageProfile.profileId) : undefined;
  const hasAccountUsageTarget =
    usageProfile !== undefined && params.usageTargetProfileIds.has(usageProfile.profileId);
  // The selected account owns the summary even while its quota is pending.
  // Independently fetched usage must not replace it with another credential.
  const usage = hasAccountUsageTarget ? accountUsage : providerUsage;
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
    displayName: (usageKey ? providerUsageLabel(usageKey) : undefined) ?? provider.provider,
    status:
      apiKey && !hasRefreshableProfile && rollup.status === "missing" ? "static" : rollup.status,
    expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: provider.profiles.map((profile) => {
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
            : localProfileIds.has(profile.profileId)
              ? "saved"
              : "inherited",
        expiry: buildExpiry(profile.remainingMs, profile.expiresAt),
        ...(params.externalCliProfileIds.has(profile.profileId) ? { externallyManaged: true } : {}),
        ...(params.includeProfileDetails && metadata.displayName
          ? { displayName: metadata.displayName }
          : {}),
        ...(params.includeProfileDetails && metadata.email ? { email: metadata.email } : {}),
        ...(params.includeProfileDetails && lastUsedAt ? { lastUsedAt } : {}),
        ...(params.includeProfileDetails && usage ? { usage: mapUsageStatus(usage) } : {}),
        ...(params.includeProfileDetails && params.pendingUsageProfileIds.has(profile.profileId)
          ? { usageRefreshPending: true }
          : {}),
        ...((profile.type === "oauth" || profile.type === "token") &&
        params.logoutProfileIds.has(profile.profileId) &&
        !params.configBoundProfileIds.has(profile.profileId)
          ? { logoutSupported: true }
          : {}),
      };
    }),
    ...(profileOrder.order !== undefined ? { profileOrder: profileOrder.order } : {}),
    ...(profileOrder.fromStore && localOrderStored ? { profileOrderStored: true } : {}),
    ...(providerOrderLocked
      ? { profileOrderLocked: "provider-config" as const }
      : configuredOrderLocked
        ? { profileOrderLocked: "auth-config" as const }
        : {}),
    ...(apiKey ? { apiKey } : {}),
    usage: usage ? mapUsageStatus(usage, params.includeProfileDetails) : undefined,
    ...(params.includeProfileDetails && hasAccountUsageTarget && accountUsage
      ? { usageProfileId: usageProfile.profileId }
      : {}),
    ...(params.includeProfileDetails && hasAccountUsageTarget && providerUsage
      ? { independentUsage: mapUsageStatus(providerUsage, params.includeProfileDetails) }
      : {}),
    ...(usage?.usageScope ? { usageScope: usage.usageScope } : {}),
  };
}

function resolveConfiguredProviders(
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

export const modelsAuthStatusHandlers: GatewayRequestHandlers = {
  "models.authLogout": async ({ params, respond, context }) => {
    const provider = readProviderParam(params);
    if (!provider) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
      return;
    }
    const selection = readLogoutProfileSelection(params);
    if (!selection.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selection.message));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const cfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(cfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const { agentDir } = scope;
      const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
      const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      const availableProfiles = listProfilesForProvider(store, provider);
      const removedProfiles = selection.profileIds ?? availableProfiles;
      if (
        selection.profileIds &&
        selection.profileIds.some((profileId) => {
          const profile = store.profiles[profileId];
          return (
            !availableProfiles.includes(profileId) ||
            (profile?.type !== "oauth" && profile?.type !== "token")
          );
        })
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain unavailable auth profiles"),
        );
        return;
      }
      const configBoundProfileIds = selection.profileIds
        ? resolveConfigBoundProfileIds(cfg, store)
        : null;
      if (selection.profileIds?.some((profileId) => configBoundProfileIds?.has(profileId))) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain config-bound auth profiles"),
        );
        return;
      }
      // Revoke captured usage authority before the durable mutation starts.
      // Otherwise usage work can finish while the auth store is being updated
      // and publish a result for credentials that logout is removing.
      invalidateModelAuthStatusCache();
      let removed: boolean;
      try {
        removed = selection.profileIds
          ? await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: removedProfiles })
          : await removeProviderAuthProfilesAcrossOwnerStores({
              provider,
              agentDir,
              profileIds: removedProfiles,
            });
        await refreshActiveProviderAuthRuntimeSnapshot();
      } finally {
        // Status reads can admit new usage while removal or publication awaits.
        // Revoke that generation before acknowledging either success or failure.
        invalidateModelAuthStatusCache();
      }
      if (!removed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to remove saved auth profiles for provider ${provider}`,
          ),
        );
        return;
      }
      void warmCurrentProviderAuthStateOffMainThread(context.getRuntimeConfig()).catch(
        (err: unknown) => {
          log.warn(`provider auth state rewarm after logout failed: ${formatForLog(err)}`);
        },
      );
      // A provider-wide abort would terminate runs using credentials this
      // logout preserved (other profiles, tokens, or the config API key). Abort
      // entries do not carry the profile id, so a targeted logout cannot scope
      // the abort and instead leaves in-flight runs to fail on their next
      // request; only a full-provider logout revokes everything and aborts.
      const { runIds: abortedRunIds } = selection.profileIds
        ? { runIds: [] as string[] }
        : abortChatRunsForProvider(createAuthLogoutAbortOps(context), {
            cfg,
            providerId: authProvider,
            agentId: scope.agentId,
            stopReason: "auth-revoked",
          });
      const result: ModelAuthLogoutResult = {
        provider,
        removedProfiles,
        abortedRunIds,
      };
      respond(true, result, undefined);
    });
  },
  "models.authStatus": async ({ params, respond, context, client }) => {
    const now = Date.now();
    const refreshRequested = Boolean(params.refresh);
    const includeProfileDetails =
      Array.isArray(client?.connect?.scopes) && client.connect.scopes.includes(ADMIN_SCOPE);
    const resolveScope = (cfg: OpenClawConfig) =>
      resolveModelAuthAgentScope(
        cfg,
        params.agentId === undefined || params.agentId === ""
          ? tryResolveAmbientOwnerAgentId(cfg)
          : params.agentId,
      );
    await respondUnavailableOnThrow(respond, async () => {
      let cfg = context.getRuntimeConfig();
      let scope = resolveScope(cfg);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      if (refreshRequested) {
        await refreshModelAuthStatusRuntimeState();
        cfg = context.getRuntimeConfig();
        scope = resolveScope(cfg);
        if (!scope.ok) {
          respond(false, undefined, modelAuthAgentScopeError(scope));
          return;
        }
      }
      const preparedSnapshot = refreshRequested
        ? await loadDeferredCatalog(context, scope.agentId, {
            readOnly: true,
            authScope: resolveAuthRefreshScope(cfg),
            refreshAuth: true,
            refreshFullCatalog: false,
          })
        : await readPreparedCatalog(context, scope.agentId);
      if (!preparedSnapshot) {
        // A lifecycle replacement may temporarily withdraw this owner. Status must not
        // rediscover credentials or turn missing preparation into a connection failure.
        const result: ModelAuthStatusResult = {
          ts: now,
          providers: [],
          unavailable: {
            code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
            message:
              "Model authentication status is unavailable. Refresh Models after setup finishes; restart the Gateway if it persists.",
          },
        };
        respond(true, result, undefined);
        return;
      }
      cfg = preparedSnapshot.config;
      const { agentId, agentDir, authStore: store, workspaceDir } = preparedSnapshot;
      // Generic auth helpers may consult provider metadata indirectly. Carry this owner's exact
      // snapshot through them so a global miss cannot rediscover plugins on the event loop.
      const authAliasLookupParams: PreparedAuthMetadataLookupParams = {
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
        includeUntrustedWorkspacePlugins: false,
      };
      const apiKeys = resolveProviderApiKeys(cfg, store, authAliasLookupParams);
      const configured = resolveConfiguredProviders(cfg, apiKeys);
      const statusProviderIds = new Set(configured.providers);
      for (const provider of apiKeys.keys()) {
        statusProviderIds.add(provider);
      }
      for (const profile of Object.values(store.profiles)) {
        const provider = normalizeProviderId(profile.provider);
        if (provider) {
          statusProviderIds.add(provider);
        }
      }
      const authHealth: AuthHealthSummary = buildAuthHealthSummary({
        store,
        cfg,
        providers: statusProviderIds.size > 0 ? [...statusProviderIds] : undefined,
        allowKeychainPrompt: false,
        authAliasLookupParams,
      });

      // Exact-profile reads below cover account quotas. Admin credentials expose
      // separate organization history, so those providers retain an unscoped read.
      const providerWideUsageIds = resolveProviderUsageAuthEnvCredentialProviders({
        config: cfg,
        env: process.env,
        plugins: preparedSnapshot.metadataSnapshot.plugins,
      });
      const providerUsageRuntime = getProviderUsageRuntimeSnapshot({
        config: cfg,
        agentId,
        agentDir,
        store,
      });
      const activeUsageProviderIds = new Set(providerUsageRuntime.providerIds);
      for (const provider of providerUsageRuntime.providerIds) {
        if (providerUsageRuntime.directApiKeys.has(provider)) {
          providerWideUsageIds.add(provider);
        }
      }
      const usageProviderIds = new Set<UsageProviderId>();
      const usageTargets: Array<{ profileId: string; providerId: UsageProviderId }> = [];
      for (const profile of authHealth.profiles) {
        const providerId = resolveUsageProviderId(profile.provider, {
          credentialType: profile.type,
        });
        if (!providerId || !activeUsageProviderIds.has(providerId)) {
          continue;
        }
        const credential = store.profiles[profile.profileId];
        const isLogin =
          profile.type === "oauth" ||
          profile.type === "token" ||
          (credential?.type === "api_key" && Boolean(credential.metadata?.authFlow));
        if (isLogin) {
          usageTargets.push({ profileId: profile.profileId, providerId });
        }
        if (providerWideUsageIds.has(providerId) || (profile.type === "api_key" && !isLogin)) {
          usageProviderIds.add(providerId);
        }
      }
      const providerUsage =
        usageProviderIds.size > 0
          ? readProviderUsageStaleWhileRevalidate({
              agentId,
              agentDir,
              authStore: providerUsageRuntime.store,
              configRef: cfg,
              credentialKey: providerUsageRuntime.credentialKey,
              forceRefresh: refreshRequested,
              providerIds: [...usageProviderIds],
              now,
            })
          : { usageByProvider: new Map<string, ProviderUsageStatus>(), refreshPending: false };
      const externalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(store));
      const profileUsage = readProfileUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        workspaceDir,
        authStore: providerUsageRuntime.store,
        configRef: cfg,
        profileCredentialKeys: providerUsageRuntime.profileCredentialKeys,
        forceRefresh: refreshRequested,
        targets: usageTargets,
        now,
      });

      const externalProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
      const logoutProfileIds = new Set(
        Object.entries(store.profiles)
          .filter(
            ([profileId, profile]) =>
              !externalProfileIds.has(profileId) &&
              (profile.type === "oauth" || profile.type === "token"),
          )
          .map(([profileId]) => profileId),
      );
      const configBoundProfileIds = resolveConfigBoundProfileIds(cfg, store, authAliasLookupParams);
      // Priority mutations cover the whole auth owner, including profiles under aliases.
      // Every alias must advertise that same lock while profile source/logout stays individual.
      const configBoundAuthProviders = new Set(
        Object.entries(store.profiles)
          .filter(([profileId]) => configBoundProfileIds.has(profileId))
          .map(([, profile]) => resolveProviderIdForAuth(profile.provider, authAliasLookupParams)),
      );
      const providers = authHealth.providers.map((provider) =>
        mapAuthStatusProvider({
          provider,
          config: cfg,
          store,
          authAliasLookupParams,
          usageByProvider: providerUsage.usageByProvider,
          usageByProfile: profileUsage.usageByProfile,
          usageTargetProfileIds: profileUsage.targetProfileIds,
          pendingUsageProfileIds: profileUsage.pendingProfileIds,
          expectsOAuthSet: configured.expectsOAuth,
          apiKeys,
          logoutProfileIds,
          configBoundProfileIds,
          configBoundAuthProviders,
          externalProfileIds,
          externalCliProfileIds,
          includeProfileDetails,
        }),
      );
      const providerCapabilities = resolveModelProviderCapabilities({
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
      }).capabilities;
      const result: ModelAuthStatusResult = {
        ts: now,
        providers,
        providerCapabilities,
        ...(profileUsage.refreshPending || providerUsage.refreshPending
          ? { usageRefreshPending: true }
          : {}),
      };
      respond(true, result, undefined);
    });
  },
};
