// Model auth status methods report provider credential health, profile expiry,
// usage windows, cleanup actions, and auth-state refreshes.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  ErrorCodes,
  errorShape,
  validateModelsAuthRefreshParams,
} from "../../../packages/gateway-protocol/src/index.js";
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
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
  removeProviderAuthProfilesWithLock,
  resolveAuthProfileMetadata,
  resolveExplicitAuthOrderSelection,
  resolvePersistedAuthProfileOwnerAgentDir,
  type RuntimeAuthProfileStore,
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
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthExpiry,
  ModelAuthLogoutResult,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelProviderCapability,
} from "./models-auth-status.types.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

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
const apiKeyUsageStatusProviders = new Set<UsageProviderId>(["clawrouter", "deepseek"]);

type PreparedAuthMetadataLookupParams = ProviderAuthAliasLookupParams & {
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
};

function buildProviderCapabilities(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
}): ModelProviderCapability[] {
  return resolveModelProviderCapabilities(params).capabilities;
}

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

/** Refresh transient Gateway auth owners after one durable credential mutation. */
export async function refreshModelAuthStateAfterMutation(
  context: GatewayRequestContext,
  operation: "login" | "logout" | "update",
): Promise<void> {
  invalidateModelAuthStatusCache();
  await refreshActiveProviderAuthRuntimeSnapshot();
  void warmCurrentProviderAuthStateOffMainThread(context.getRuntimeConfig()).catch(
    (err: unknown) => {
      log.warn(`provider auth state rewarm after ${operation} failed: ${formatForLog(err)}`);
    },
  );
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

function providerDisplayName(provider: string): string {
  const usageId = resolveUsageProviderId(provider);
  const usageLabel = usageId ? providerUsageLabel(usageId) : undefined;
  if (usageLabel) {
    return usageLabel;
  }
  return provider;
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

function mapProvider(
  prov: AuthProviderHealth,
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  authAliasLookupParams: ProviderAuthAliasLookupParams,
  usageByProvider: Map<string, ProviderUsageStatus>,
  expectsOAuthSet: Set<string>,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
  logoutProfileIds: ReadonlySet<string>,
  configBoundProfileIds: ReadonlySet<string>,
  oauthRefreshProviderIds: ReadonlySet<string>,
  externalProfileIds: ReadonlySet<string>,
  externalCliProfileIds: ReadonlySet<string>,
  includeProfileIdentity: boolean,
): ModelAuthStatusProvider {
  const providerKey = normalizeProviderId(prov.provider);
  const authProviderKey = resolveProviderIdForAuth(prov.provider, authAliasLookupParams);
  const profileOrder = resolveExplicitAuthOrderSelection({
    storeOrder: store.order,
    configuredOrder: cfg.auth?.order,
    providerKey,
    providerAuthKey: authProviderKey,
  });
  const runtimeStore: RuntimeAuthProfileStore = store;
  const localProfileIds = new Set(
    runtimeStore.runtimeLocalProfileIds ??
      Object.keys(store.profiles).filter((profileId) => !externalProfileIds.has(profileId)),
  );
  const providerOrderLocked = prov.profiles.some((profile) =>
    configBoundProfileIds.has(profile.profileId),
  );
  const configuredOrderLocked = profileOrder.order !== undefined && !profileOrder.fromStore;
  const usageProfile =
    prov.profiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
    prov.profiles.find((profile) => profile.type === "api_key");
  const usageKey = resolveUsageProviderId(prov.provider, {
    credentialType: usageProfile?.type,
  });
  const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
  const rawRollup = aggregateRefreshableAuthStatus(
    prov,
    Date.now(),
    expectsOAuthSet.has(prov.provider),
  );
  const effectiveProfiles = prov.effectiveProfiles ?? prov.profiles;
  const refreshableProfiles = effectiveProfiles.filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  // The prepared runtime generation owns this renewal fact. Keep raw profile
  // expiry diagnostic, but do not turn managed access-token rotation into a login warning.
  const oauthRenewalOwned =
    refreshableProfiles.length > 0 &&
    refreshableProfiles.every(
      (profile) =>
        profile.type === "oauth" &&
        (externalCliProfileIds.has(profile.profileId) ||
          oauthRefreshProviderIds.has(normalizeProviderId(profile.provider))),
    );
  const rollup: ModelAuthStatusRollup =
    oauthRenewalOwned && (rawRollup.status === "expired" || rawRollup.status === "expiring")
      ? { status: "ok" }
      : rawRollup;
  const apiKey = apiKeys.get(normalizeProviderId(prov.provider));
  const hasRefreshableProfile = prov.profiles.some(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  return {
    provider: prov.provider,
    authProvider: authProviderKey,
    displayName: providerDisplayName(prov.provider),
    status:
      apiKey && !hasRefreshableProfile && rollup.status === "missing" ? "static" : rollup.status,
    expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: prov.profiles.map((prof) => {
      const metadata = resolveAuthProfileMetadata({ cfg, store, profileId: prof.profileId });
      const lastUsedAt = store.usageStats?.[prof.profileId]?.lastUsed;
      return {
        profileId: prof.profileId,
        type: prof.type,
        status: prof.status,
        reasonCode: prof.reasonCode,
        ...(prof.secretRef ? { secretRef: prof.secretRef } : {}),
        source: configBoundProfileIds.has(prof.profileId)
          ? "config"
          : externalProfileIds.has(prof.profileId)
            ? "external"
            : localProfileIds.has(prof.profileId)
              ? "saved"
              : "inherited",
        expiry: buildExpiry(prof.remainingMs, prof.expiresAt),
        ...(externalCliProfileIds.has(prof.profileId) ? { externallyManaged: true } : {}),
        ...(includeProfileIdentity && metadata.displayName
          ? { displayName: metadata.displayName }
          : {}),
        ...(includeProfileIdentity && metadata.email ? { email: metadata.email } : {}),
        ...(includeProfileIdentity && lastUsedAt ? { lastUsedAt } : {}),
        ...(logoutProfileIds.has(prof.profileId) && !configBoundProfileIds.has(prof.profileId)
          ? { logoutSupported: true }
          : {}),
      };
    }),
    ...(profileOrder.order !== undefined ? { profileOrder: profileOrder.order } : {}),
    ...(profileOrder.fromStore ? { profileOrderStored: true } : {}),
    ...(providerOrderLocked
      ? { profileOrderLocked: "provider-config" as const }
      : configuredOrderLocked
        ? { profileOrderLocked: "auth-config" as const }
        : {}),
    ...(apiKey ? { apiKey } : {}),
    usage:
      usage && usageKey
        ? {
            providerId: usageKey,
            windows: usage.windows,
            ...(usage.summary ? { summary: usage.summary } : {}),
            ...(usage.plan ? { plan: usage.plan } : {}),
            ...(usage.billing?.length ? { billing: usage.billing } : {}),
            ...(includeProfileIdentity && usage.accountEmail
              ? { accountEmail: usage.accountEmail }
              : {}),
          }
        : undefined,
  };
}

function resolveConfiguredProviders(
  cfg: OpenClawConfig,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
): {
  providers: string[];
  expectsOAuth: Set<string>;
} {
  const out = new Set<string>();
  const expectsOAuth = new Set<string>();
  for (const [id, provider] of Object.entries(cfg.models?.providers ?? {})) {
    const normalized = normalizeProviderId(id);
    if (!normalized) {
      continue;
    }
    const rawKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
    const hasApiKey =
      hasConfiguredSecretInput(provider?.apiKey, cfg.secrets?.defaults) &&
      (rawKey === NON_ENV_SECRETREF_MARKER ||
        !isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false }));
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token" && !hasApiKey) {
      continue;
    }
    if (apiKeys.has(normalized)) {
      continue;
    }
    out.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  // auth.profiles opt in via `mode: oauth | token`; API-key profiles have no lifecycle.
  for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
    const provider = profile?.provider;
    const mode = profile?.mode;
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      (mode !== "oauth" && mode !== "token")
    ) {
      continue;
    }
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
      continue;
    }
    if (apiKeys.has(normalized)) {
      continue;
    }
    out.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  return { providers: Array.from(out), expectsOAuth };
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
    try {
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
        selection.profileIds.some((profileId) => !availableProfiles.includes(profileId))
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
      const removed = selection.profileIds
        ? await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: removedProfiles })
        : await removeProviderAuthProfilesAcrossOwnerStores({
            provider,
            agentDir,
            profileIds: removedProfiles,
          });
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
      // Fence auxiliary usage work that captured the removed profiles before
      // logout. Its later completion must not repopulate the cache.
      await refreshModelAuthStateAfterMutation(context, "logout");
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
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authRefresh": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateModelsAuthRefreshParams, "models.authRefresh", respond)
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const scope = resolveModelAuthAgentScope(
      cfg,
      params.agentId === undefined || params.agentId === ""
        ? tryResolveAmbientOwnerAgentId(cfg)
        : params.agentId,
    );
    if (!scope.ok) {
      respond(false, undefined, modelAuthAgentScopeError(scope));
      return;
    }
    try {
      await refreshModelAuthStateAfterMutation(context, params.operation);
      respond(true, { refreshed: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authStatus": async ({ params, respond, context, client }) => {
    const now = Date.now();
    const refreshRequested = Boolean(params.refresh);
    const includeProfileIdentity =
      Array.isArray(client?.connect?.scopes) && client.connect.scopes.includes(ADMIN_SCOPE);
    const resolveScope = (cfg: OpenClawConfig) =>
      resolveModelAuthAgentScope(
        cfg,
        params.agentId === undefined || params.agentId === ""
          ? tryResolveAmbientOwnerAgentId(cfg)
          : params.agentId,
      );
    try {
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

      // Usage queries usually need refreshable credentials. Keep API-key status
      // enrichment explicit so static auth providers are not polled by default.
      const usageProviderIds = [
        ...new Set(
          authHealth.profiles
            .filter((p) => {
              if (p.type === "oauth" || p.type === "token") {
                return true;
              }
              const usageProvider = resolveUsageProviderId(p.provider, {
                credentialType: p.type,
              });
              return usageProvider ? apiKeyUsageStatusProviders.has(usageProvider) : false;
            })
            .map((p) => resolveUsageProviderId(p.provider, { credentialType: p.type }))
            .filter((id): id is UsageProviderId => Boolean(id)),
        ),
      ];

      const providerUsageRuntime = getProviderUsageRuntimeSnapshot({
        config: cfg,
        agentId,
        agentDir,
        store,
      });
      const usageByProvider = readProviderUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        authStore: providerUsageRuntime.store,
        configRef: cfg,
        credentialKey: providerUsageRuntime.credentialKey,
        forceRefresh: refreshRequested,
        providerIds: usageProviderIds,
        now,
      });

      const externalProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
      const externalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(store));
      const oauthRefreshProviderIds = new Set(preparedSnapshot.oauthRefreshProviderIds);
      const logoutProfileIds = new Set(
        Object.entries(store.profiles)
          .filter(([profileId]) => !externalProfileIds.has(profileId))
          .map(([profileId]) => profileId),
      );
      const configBoundProfileIds = resolveConfigBoundProfileIds(cfg, store, authAliasLookupParams);
      const nativeRuntimeProviders = Object.entries(preparedSnapshot.providerAuth).flatMap(
        ([provider, auth]) => {
          const hasStoredProfile = Object.values(store.profiles).some(
            (profile) => normalizeProviderId(profile.provider) === provider,
          );
          return auth.runtime && !hasStoredProfile ? [{ provider, runtime: auth.runtime }] : [];
        },
      );
      const providers = [
        ...authHealth.providers.map((prov) =>
          mapProvider(
            prov,
            cfg,
            store,
            authAliasLookupParams,
            usageByProvider,
            configured.expectsOAuth,
            apiKeys,
            logoutProfileIds,
            configBoundProfileIds,
            externalProfileIds,
            oauthRefreshProviderIds,
            externalCliProfileIds,
            includeProfileIdentity,
          ),
        ),
        ...nativeRuntimeProviders
          .filter(
            ({ provider }) => !authHealth.providers.some((entry) => entry.provider === provider),
          )
          .map(({ provider, runtime }) => ({
            provider,
            displayName: providerDisplayName(provider),
            status: "ok" as const,
            profiles: [],
            agentRuntime: { id: runtime, source: "auth" as const },
          })),
      ];
      const providerCapabilities = buildProviderCapabilities({
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
      });
      const result: ModelAuthStatusResult = { ts: now, providers, providerCapabilities };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
