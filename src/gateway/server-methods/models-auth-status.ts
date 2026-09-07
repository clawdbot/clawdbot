// Model auth status methods report provider credential health, profile expiry,
// usage windows, cleanup actions, and auth-state refreshes.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { type AuthHealthSummary, buildAuthHealthSummary } from "../../agents/auth-health.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
  removeProviderAuthProfilesWithLock,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import { getRuntimeExternalCliProfileIds } from "../../agents/auth-profiles/runtime-external-profile-references.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveProviderUsageAuthEnvCredentialProviders } from "../../infra/provider-usage.auth.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
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
  mapAuthStatusProvider,
  resolveConfiguredProviders,
} from "./models-auth-status-projection.js";
import {
  clearModelAuthStatusUsageCache,
  type ProviderUsageStatus,
  readProfileUsageStaleWhileRevalidate,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthLogoutResult,
  ModelAuthStatusResult,
  ModelProviderCapability,
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
export { aggregateRefreshableAuthStatus } from "./models-auth-status-projection.js";

const log = createSubsystemLogger("models-auth-status");
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
      const usageProviderIds = [
        ...new Set(
          authHealth.profiles
            .filter((p) => {
              const usageProvider = resolveUsageProviderId(p.provider, {
                credentialType: p.type,
              });
              if (!usageProvider) {
                return false;
              }
              if (!activeUsageProviderIds.has(usageProvider)) {
                return false;
              }
              const credential = store.profiles[p.profileId];
              return (
                providerWideUsageIds.has(usageProvider) ||
                (p.type === "api_key" &&
                  credential?.type === "api_key" &&
                  !credential.metadata?.authFlow)
              );
            })
            .map((p) => resolveUsageProviderId(p.provider, { credentialType: p.type }))
            .filter((id): id is UsageProviderId => Boolean(id)),
        ),
      ];
      const providerUsage =
        usageProviderIds.length > 0
          ? readProviderUsageStaleWhileRevalidate({
              agentId,
              agentDir,
              authStore: providerUsageRuntime.store,
              configRef: cfg,
              credentialKey: providerUsageRuntime.credentialKey,
              forceRefresh: refreshRequested,
              providerIds: usageProviderIds,
              now,
            })
          : { usageByProvider: new Map<string, ProviderUsageStatus>(), refreshPending: false };
      const externalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(store));
      const profileUsage = includeProfileDetails
        ? readProfileUsageStaleWhileRevalidate({
            agentId,
            agentDir,
            workspaceDir,
            authStore: providerUsageRuntime.store,
            configRef: cfg,
            profileCredentialKeys: providerUsageRuntime.profileCredentialKeys,
            forceRefresh: refreshRequested,
            targets: authHealth.profiles.flatMap((profile) => {
              const providerId = resolveUsageProviderId(profile.provider, {
                credentialType: profile.type,
              });
              if (!providerId || !activeUsageProviderIds.has(providerId)) {
                return [];
              }
              const credential = store.profiles[profile.profileId];
              const isAccountLoginApiKey =
                profile.type === "api_key" &&
                credential?.type === "api_key" &&
                Boolean(credential.metadata?.authFlow);
              if (profile.type !== "oauth" && profile.type !== "token" && !isAccountLoginApiKey) {
                return [];
              }
              return [{ profileId: profile.profileId, providerId }];
            }),
            now,
          })
        : {
            usageByProfile: new Map<string, ProviderUsageStatus>(),
            targetProfileIds: new Set<string>(),
            pendingProfileIds: new Set<string>(),
            refreshPending: false,
          };

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
      const providerCapabilities = buildProviderCapabilities({
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
      });
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
