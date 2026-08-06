// Model auth status methods report provider credential health, profile expiry,
// usage windows, cleanup actions, and auth-state refreshes.
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
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
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
  removeProviderAuthProfilesWithLock,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps,
} from "../../agents/model-auth-env-vars.js";
import { resolveProviderEnvAuthEvidence } from "../../agents/model-auth-env.js";
import {
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
} from "../../agents/model-auth-markers.js";
import {
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { coerceSecretRef, hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { providerUsageLabel, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type { UsageProviderId } from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import { abortChatRunsForProvider, type ChatAbortOps } from "../chat-abort.js";
import { formatForLog } from "../ws-log.js";
import {
  resolveModelAuthAgentScope,
  unknownModelAuthAgentIdError,
} from "./model-auth-agent-scope.js";
import {
  clearModelAuthStatusUsageCache,
  fingerprintProviderUsageCredentials,
  type ProviderUsageStatus,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthExpiry,
  ModelAuthLogoutResult,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
} from "./models-auth-status.types.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

export type {
  ModelAuthExpiry,
  ModelAuthLogoutResult,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
} from "./models-auth-status.types.js";

const log = createSubsystemLogger("models-auth-status");
const apiKeyUsageStatusProviders = new Set<UsageProviderId>(["clawrouter", "deepseek"]);

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
  // Keep same-credential usage visible while the explicit refresh replaces it.
  // A changed credential/config produces a different cache key below; logout
  // still uses invalidateModelAuthStatusCache() and clears usage immediately.
  clearCurrentProviderAuthState();
  try {
    if (await refreshActiveProviderAuthRuntimeSnapshot()) {
      return;
    }
  } catch (err) {
    log.warn(`runtime auth snapshot refresh before auth status failed: ${formatForLog(err)}`);
    return;
  }
  // Explicit status refresh follows CLI/doctor repairs. If no secrets runtime is
  // active, drop runtime auth snapshots so the next status read observes disk.
  clearRuntimeAuthProfileStoreSnapshots();
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
  usageByProvider: Map<string, ProviderUsageStatus>,
  expectsOAuthSet: Set<string>,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
  logoutProfileIds: ReadonlySet<string>,
  configBoundProfileIds: ReadonlySet<string>,
): ModelAuthStatusProvider {
  const usageProfile =
    prov.profiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
    prov.profiles.find((profile) => profile.type === "api_key");
  const usageKey = resolveUsageProviderId(prov.provider, {
    credentialType: usageProfile?.type,
  });
  const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
  const rollup = aggregateRefreshableAuthStatus(
    prov,
    Date.now(),
    expectsOAuthSet.has(prov.provider),
  );
  const apiKey = apiKeys.get(normalizeProviderId(prov.provider));
  const hasRefreshableProfile = prov.profiles.some(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  return {
    provider: prov.provider,
    displayName: providerDisplayName(prov.provider),
    status:
      apiKey && !hasRefreshableProfile && rollup.status === "missing" ? "static" : rollup.status,
    expiry: buildExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: prov.profiles.map((prof) => ({
      profileId: prof.profileId,
      type: prof.type,
      status: prof.status,
      reasonCode: prof.reasonCode,
      expiry: buildExpiry(prof.remainingMs, prof.expiresAt),
      ...((prof.type === "oauth" || prof.type === "token") &&
      logoutProfileIds.has(prof.profileId) &&
      !configBoundProfileIds.has(prof.profileId)
        ? { logoutSupported: true }
        : {}),
    })),
    ...(apiKey ? { apiKey } : {}),
    usage:
      usage && usageKey
        ? {
            providerId: usageKey,
            windows: usage.windows,
            ...(usage.summary ? { summary: usage.summary } : {}),
            ...(usage.plan ? { plan: usage.plan } : {}),
            ...(usage.billing?.length ? { billing: usage.billing } : {}),
            ...(usage.accountEmail ? { accountEmail: usage.accountEmail } : {}),
          }
        : undefined,
  };
}

// API-key provenance stays presence-only. SecretRef ids may be shown, but
// credential values never cross this status boundary.
function resolveEnvVarName(source: string): string | undefined {
  const match = /^(?:shell env|env): ([A-Z][A-Z0-9_]*)$/u.exec(source);
  return match?.[1];
}

function resolveProviderApiKeys(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
): Map<string, ModelAuthStatusProvider["apiKey"]> {
  const lookupMaps = resolveProviderEnvAuthLookupMaps({ config: cfg, env: process.env });
  const providerIds = new Set<string>([
    ...Object.keys(cfg.models?.providers ?? {}),
    ...Object.values(cfg.auth?.profiles ?? {})
      .map((profile) => profile?.provider)
      .filter((provider): provider is string => typeof provider === "string"),
    ...listProviderEnvAuthLookupKeys(lookupMaps),
  ]);
  const apiKeys = new Map<string, ModelAuthStatusProvider["apiKey"]>();
  for (const rawProvider of providerIds) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider) {
      continue;
    }
    const providerConfig = findNormalizedProviderValue(cfg.models?.providers, provider);
    if (hasConfiguredSecretInput(providerConfig?.apiKey, cfg.secrets?.defaults)) {
      const ref = coerceSecretRef(providerConfig?.apiKey, cfg.secrets?.defaults);
      const profileReference = resolveProviderEntryApiKeyProfileReference({
        cfg,
        provider,
        store,
      });
      if (profileReference.kind !== "profile" && profileReference.kind !== "profile-incompatible") {
        if (ref && ref.source !== "env") {
          apiKeys.set(provider, { source: "config" });
          continue;
        }
        const available = resolveUsableCustomProviderApiKey({
          cfg,
          provider,
          env: process.env,
        });
        if (available) {
          const rawKey =
            typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : "";
          // Local no-auth placeholders (e.g. the ollama-local marker) resolve to
          // a usable value but represent no credential; do not advertise them as
          // a configured API key or the provider would render as static.
          if (rawKey && isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false })) {
            continue;
          }
          const envVar =
            ref?.source === "env"
              ? ref.id
              : profileReference.kind === "marker" && isKnownEnvApiKeyMarker(rawKey)
                ? rawKey
                : resolveEnvVarName(available.source);
          apiKeys.set(provider, envVar ? { source: "env", envVar } : { source: "config" });
          continue;
        }
      }
    }
    const envEvidence = resolveProviderEnvAuthEvidence(provider, process.env, {
      aliasMap: lookupMaps.aliasMap,
      candidateMap: lookupMaps.envCandidateMap,
      authEvidenceMap: lookupMaps.authEvidenceMap,
    });
    if (envEvidence?.mode !== "api-key") {
      continue;
    }
    const envVar = resolveEnvVarName(envEvidence.source);
    apiKeys.set(provider, { source: "env", ...(envVar ? { envVar } : {}) });
  }
  return apiKeys;
}

function resolveConfigBoundProfileIds(cfg: OpenClawConfig, store: AuthProfileStore): Set<string> {
  const profileIds = new Set<string>();
  for (const provider of Object.keys(cfg.models?.providers ?? {})) {
    const reference = resolveProviderEntryApiKeyProfileReference({ cfg, provider, store });
    if (reference.kind === "profile" || reference.kind === "profile-incompatible") {
      profileIds.add(reference.profileId);
    }
  }
  return profileIds;
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
        respond(false, undefined, unknownModelAuthAgentIdError(scope.agentId));
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
      invalidateModelAuthStatusCache();
      await refreshActiveProviderAuthRuntimeSnapshot();
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
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authStatus": async ({ params, respond, context }) => {
    const now = Date.now();
    const refreshRequested = Boolean(params.refresh);
    try {
      let cfg = context.getRuntimeConfig();
      let scope = resolveModelAuthAgentScope(cfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, unknownModelAuthAgentIdError(scope.agentId));
        return;
      }
      if (refreshRequested) {
        await refreshModelAuthStatusRuntimeState();
        cfg = context.getRuntimeConfig();
        scope = resolveModelAuthAgentScope(cfg, params.agentId);
        if (!scope.ok) {
          respond(false, undefined, unknownModelAuthAgentIdError(scope.agentId));
          return;
        }
      }
      const { agentId, agentDir } = scope;
      // Use the external-profile-aware store for status reads so the dashboard
      // reflects CLI-discovered credentials without persisting them here.
      const store = ensureAuthProfileStore(agentDir, {
        externalCli: externalCliDiscoveryForConfigStatus({ cfg }),
      });
      const apiKeys = resolveProviderApiKeys(cfg, store);
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

      const usageByProvider = readProviderUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        configRef: cfg,
        credentialKey: fingerprintProviderUsageCredentials({
          cfg,
          directApiKeys: apiKeys,
          store,
        }),
        forceRefresh: refreshRequested,
        providerIds: usageProviderIds,
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
      const configBoundProfileIds = resolveConfigBoundProfileIds(cfg, store);
      const providers = authHealth.providers.map((prov) =>
        mapProvider(
          prov,
          usageByProvider,
          configured.expectsOAuth,
          apiKeys,
          logoutProfileIds,
          configBoundProfileIds,
        ),
      );
      const result: ModelAuthStatusResult = { ts: now, providers };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
