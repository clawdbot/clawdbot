/**
 * Ordered credential resolution for one provider request.
 */
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildProviderMissingAuthMessageWithPlugin,
  shouldDeferProviderSyntheticProfileAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveOwningPluginIdsForProviderRef } from "../plugins/providers.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { resolveDefaultAgentDir } from "./agent-scope-config.js";
import {
  type AuthProfileStore,
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  resolveAuthStorePathForDisplay,
} from "./auth-profiles.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { assertAuthModeAllowedForModel, isAuthModeAllowedForModel } from "./model-auth-openai.js";
import * as authConfig from "./model-auth-provider-config.js";
import { ProviderAuthError, type ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import {
  assertRuntimeProviderSecretOwnerAvailable,
  resolveManagedSecretRefRuntimeProviderAuth,
  resolveSyntheticLocalProviderAuth,
} from "./model-auth-runtime.js";

export type ProviderCredentialPrecedence = "profile-first" | "env-first";

const log = createSubsystemLogger("model-auth");

function shouldDeferSyntheticProfileAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  resolvedApiKey: string | undefined;
  modelApi?: string;
}): boolean {
  const providerConfig = authConfig.resolveProviderConfig(params.cfg, params.provider);
  return (
    shouldDeferProviderSyntheticProfileAuthWithPlugin({
      provider: params.provider,
      config: params.cfg,
      modelApi: params.modelApi,
      context: {
        config: params.cfg,
        provider: params.provider,
        providerConfig,
        resolvedApiKey: params.resolvedApiKey,
      },
    }) === true
  );
}

export function resolveScopedAuthProfileStore(params: {
  agentDir?: string;
  cfg?: OpenClawConfig;
  provider: string;
  profileId?: string;
  preferredProfile?: string;
}): AuthProfileStore {
  return ensureAuthProfileStore(params.agentDir, {
    externalCli: externalCliDiscoveryForProviderAuth(params),
  });
}

/** Resolves the credential that should be used for one provider request. */
export async function resolveApiKeyForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  /** When true, treat profileId as a user-locked selection that must not be
   *  silently overridden by env/config credentials. */
  lockedProfile?: boolean;
  forceRefresh?: boolean;
  credentialPrecedence?: ProviderCredentialPrecedence;
  /** Skip implicit profile discovery for a prepared env/config fallback attempt. */
  allowAuthProfileFallback?: boolean;
  /** Skip plugin setup fallback when the prepared route already excludes it. */
  skipSetupProviderFallback?: boolean;
  modelId?: string;
  modelApi?: string;
  /** Keep SecretRef-backed model credentials opaque until a sentinel-aware transport boundary. */
  secretSentinels?: boolean;
}): Promise<ResolvedProviderAuth> {
  const { provider, cfg, profileId, preferredProfile } = params;
  // A failed explicit ref owns the provider. Stop before profile/env discovery so requests cannot
  // silently switch credentials while this configured owner is cold.
  assertRuntimeProviderSecretOwnerAvailable({ cfg, provider });
  const agentDir = params.agentDir?.trim() || (cfg ? resolveDefaultAgentDir(cfg) : undefined);
  let scopedStore: AuthProfileStore | undefined = params.store;
  const getScopedStore = (requestedProfileId?: string) =>
    (scopedStore ??= resolveScopedAuthProfileStore({
      agentDir,
      cfg,
      provider,
      profileId: requestedProfileId,
      preferredProfile,
    }));

  if (profileId) {
    const awsSdkProfileAuth = authConfig.resolveConfiguredAwsSdkProfileAuth({
      cfg,
      provider,
      profileId,
    });
    if (awsSdkProfileAuth) {
      return awsSdkProfileAuth;
    }
    const store = getScopedStore(profileId);
    const configuredProfileType = store.profiles[profileId]?.type;
    if (configuredProfileType) {
      assertAuthModeAllowedForModel({
        provider,
        modelApi: params.modelApi,
        profileId,
        mode: authConfig.profileTypeToAuthMode(configuredProfileType),
      });
    }
    const resolved = await resolveApiKeyForProfile({
      cfg,
      store,
      profileId,
      agentDir,
      forceRefresh: params.forceRefresh,
    });
    if (!resolved) {
      throw new Error(`No credentials found for profile "${profileId}".`);
    }
    const resolvedProfileId = resolved.profileId ?? profileId;
    const mode = resolved.profileType ?? store.profiles[resolvedProfileId]?.type;
    const result: ResolvedProviderAuth = {
      apiKey: authConfig.sentinelizeSecretRefProfileApiKey({
        apiKey: resolved.apiKey,
        enabled: params.secretSentinels,
        profileId: resolvedProfileId,
        provider,
        store,
      }),
      profileId: resolvedProfileId,
      source: `profile:${resolvedProfileId}`,
      mode: mode ? authConfig.profileTypeToAuthMode(mode) : "api-key",
    };
    assertAuthModeAllowedForModel({
      provider,
      modelApi: params.modelApi,
      profileId: resolvedProfileId,
      mode: result.mode,
    });
    // When the resolved key is a provider-owned synthetic profile marker and
    // the caller has not locked this profile, fall through to env/config
    // resolution so provider-owned real credentials take precedence. The auth
    // controller iterates profile candidates and passes each as an explicit
    // profileId, so we cannot assume explicit === user-locked.
    if (
      !params.lockedProfile &&
      shouldDeferSyntheticProfileAuth({
        cfg,
        provider,
        resolvedApiKey: resolved.apiKey,
        modelApi: params.modelApi,
      })
    ) {
      return resolveApiKeyForProvider({
        ...params,
        store,
        profileId: undefined,
        lockedProfile: true,
      }) //
        .catch(() => result);
    }
    return result;
  }

  if (params.allowAuthProfileFallback !== false && (cfg?.auth?.profiles || cfg?.auth?.order)) {
    const store = getScopedStore();
    const configuredProfileOrder = resolveAuthProfileOrder({
      cfg,
      store,
      provider,
      preferredProfile,
      forModel: params.modelId,
    });
    for (const candidate of configuredProfileOrder) {
      const awsSdkProfileAuth = authConfig.resolveConfiguredAwsSdkProfileAuth({
        cfg,
        provider,
        profileId: candidate,
      });
      if (awsSdkProfileAuth) {
        return awsSdkProfileAuth;
      }
    }
  }

  const authOverride = authConfig.resolveProviderAuthOverride(cfg, provider);
  if (authOverride === "aws-sdk") {
    return authConfig.resolveAwsSdkAuthInfo();
  }
  if (authConfig.shouldUseImplicitAwsSdkAuth({ cfg, provider, modelApi: params.modelApi })) {
    return authConfig.resolveAwsSdkAuthInfo();
  }

  if (params.credentialPrecedence === "env-first") {
    const envResolved = authConfig.resolveConfigAwareEnvApiKey(
      cfg,
      provider,
      params.workspaceDir,
      params.skipSetupProviderFallback,
    );
    if (envResolved) {
      const resolvedMode = authConfig.resolveDirectProviderCredentialMode({
        cfg,
        provider,
        inferredMode: envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
      });
      if (
        !isAuthModeAllowedForModel({
          provider,
          modelApi: params.modelApi,
          mode: resolvedMode,
        })
      ) {
        return resolveApiKeyForProvider({ ...params, credentialPrecedence: "profile-first" });
      }
      return {
        apiKey: authConfig.sentinelizeConfigSecretRefEnvApiKey({
          apiKey: envResolved.apiKey,
          source: envResolved.source,
          cfg,
          provider,
          enabled: params.secretSentinels,
        }),
        source: envResolved.source,
        mode: resolvedMode,
      };
    }
  }

  // Resolve stored profile-id references before literal apiKey fallbacks.
  // Matched profile references are terminal so bad bindings cannot silently
  // fall through to a different credential or to the profile id as bearer text.
  const providerEntryStore = getScopedStore();
  const providerEntryBinding = await authConfig.resolveProviderEntryApiKeyBinding({
    cfg,
    provider,
    store: providerEntryStore,
    agentDir,
    secretSentinels: params.secretSentinels,
  });
  if (providerEntryBinding.kind === "profile-resolved") {
    assertAuthModeAllowedForModel({
      provider,
      modelApi: params.modelApi,
      profileId: providerEntryBinding.auth.profileId ?? provider,
      mode: providerEntryBinding.auth.mode,
    });
    return providerEntryBinding.auth;
  }
  if (providerEntryBinding.kind === "profile-incompatible") {
    const reason =
      providerEntryBinding.reason === "credential-class"
        ? "which is not a bearer-style auth class"
        : "which is not compatible with this provider entry's auth binding";
    const action =
      providerEntryBinding.reason === "credential-class"
        ? "Use an api-key or token profile, or set apiKey to a literal bearer token."
        : "Use a compatible provider auth alias, configure the referenced provider entry with the same baseUrl, or set apiKey to a literal bearer token.";
    throw new Error(
      `Per-entry apiKey "${providerEntryBinding.profileId}" for provider "${provider}" references a "${providerEntryBinding.credentialType}" credential for provider "${providerEntryBinding.credentialProvider}", ${reason}. ${action}`,
    );
  }
  if (providerEntryBinding.kind === "profile-unresolved") {
    const cause = providerEntryBinding.error
      ? formatErrorMessage(providerEntryBinding.error)
      : "credential resolution returned no key";
    throw new Error(
      `Per-entry apiKey "${providerEntryBinding.profileId}" for provider "${provider}" matched a stored profile but failed to resolve: ${cause}. Fix the referenced profile or set apiKey to a literal bearer token.`,
    );
  }

  if (authConfig.shouldPreferExplicitConfigApiKeyAuth(cfg, provider)) {
    const runtimeCustomKey = resolveManagedSecretRefRuntimeProviderAuth({
      cfg,
      provider,
      secretSentinels: params.secretSentinels,
    });
    if (runtimeCustomKey) {
      return runtimeCustomKey;
    }
    const customKey = authConfig.resolveUsableCustomProviderApiKey({
      cfg,
      provider,
      secretSentinels: params.secretSentinels,
    });
    if (customKey) {
      return {
        apiKey: customKey.apiKey,
        source: customKey.source,
        mode: "api-key",
      };
    }
  }
  const providerConfig = authConfig.resolveProviderConfig(cfg, provider);
  const configuredLocalKey = authConfig.resolveUsableCustomProviderApiKey({
    cfg,
    provider,
    secretSentinels: params.secretSentinels,
  });
  if (configuredLocalKey && isNonSecretApiKeyMarker(configuredLocalKey.apiKey)) {
    return {
      apiKey: configuredLocalKey.apiKey,
      source: configuredLocalKey.source,
      mode: "api-key",
    };
  }
  const localMarkerEnv = authConfig.resolveConfigAwareEnvApiKey(
    cfg,
    provider,
    params.workspaceDir,
    params.skipSetupProviderFallback,
  );
  if (localMarkerEnv && isNonSecretApiKeyMarker(localMarkerEnv.apiKey)) {
    return {
      apiKey: localMarkerEnv.apiKey,
      source: localMarkerEnv.source,
      mode: "api-key",
    };
  }
  const store = getScopedStore();
  const order =
    params.allowAuthProfileFallback === false
      ? []
      : resolveAuthProfileOrder({
          cfg,
          store,
          provider,
          preferredProfile,
          forModel: params.modelId,
        });
  let deferredAuthProfileResult: ResolvedProviderAuth | null = null;
  let refreshFailure: OAuthRefreshFailureError | undefined;
  for (const candidate of order) {
    let candidateMode: ResolvedProviderAuth["mode"] | undefined;
    try {
      const awsSdkProfileAuth = authConfig.resolveConfiguredAwsSdkProfileAuth({
        cfg,
        provider,
        profileId: candidate,
      });
      if (awsSdkProfileAuth) {
        return awsSdkProfileAuth;
      }
      const candidateType = store.profiles[candidate]?.type;
      candidateMode = candidateType ? authConfig.profileTypeToAuthMode(candidateType) : undefined;
      if (
        candidateMode &&
        !isAuthModeAllowedForModel({
          provider,
          modelApi: params.modelApi,
          mode: candidateMode,
        })
      ) {
        continue;
      }
      const resolved = await resolveApiKeyForProfile({
        cfg,
        store,
        profileId: candidate,
        agentDir,
        forceRefresh: params.forceRefresh,
      });
      if (resolved) {
        const resolvedProfileId = resolved.profileId ?? candidate;
        const mode = resolved.profileType ?? store.profiles[resolvedProfileId]?.type;
        const resolvedMode: ResolvedProviderAuth["mode"] = mode
          ? authConfig.profileTypeToAuthMode(mode)
          : "api-key";
        const result: ResolvedProviderAuth = {
          apiKey: authConfig.sentinelizeSecretRefProfileApiKey({
            apiKey: resolved.apiKey,
            enabled: params.secretSentinels,
            profileId: resolvedProfileId,
            provider,
            store,
          }),
          profileId: resolvedProfileId,
          source: `profile:${resolvedProfileId}`,
          mode: resolvedMode,
        };
        if (
          !isAuthModeAllowedForModel({
            provider,
            modelApi: params.modelApi,
            mode: result.mode,
          })
        ) {
          continue;
        }
        if (
          shouldDeferSyntheticProfileAuth({
            cfg,
            provider,
            resolvedApiKey: resolved.apiKey,
            modelApi: params.modelApi,
          })
        ) {
          deferredAuthProfileResult ??= result;
          continue;
        }
        return result;
      }
    } catch (err) {
      if (err instanceof SecretSurfaceUnavailableError) {
        throw err;
      }
      if (
        !refreshFailure &&
        err instanceof OAuthRefreshFailureError &&
        (!candidateMode ||
          isAuthModeAllowedForModel({
            provider,
            modelApi: params.modelApi,
            mode: candidateMode,
          }))
      ) {
        refreshFailure = err;
      }
      log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
    }
  }

  if (refreshFailure) {
    throw refreshFailure;
  }

  const envResolved = authConfig.resolveConfigAwareEnvApiKey(
    cfg,
    provider,
    params.workspaceDir,
    params.skipSetupProviderFallback,
  );
  if (envResolved) {
    const resolvedMode = authConfig.resolveDirectProviderCredentialMode({
      cfg,
      provider,
      inferredMode: envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
    });
    if (
      isAuthModeAllowedForModel({
        provider,
        modelApi: params.modelApi,
        mode: resolvedMode,
      })
    ) {
      const result: ResolvedProviderAuth = {
        apiKey: authConfig.sentinelizeConfigSecretRefEnvApiKey({
          apiKey: envResolved.apiKey,
          source: envResolved.source,
          cfg,
          provider,
          enabled: params.secretSentinels,
        }),
        source: envResolved.source,
        mode: resolvedMode,
      };
      return result;
    }
  }

  const managedRuntimeAuth = resolveManagedSecretRefRuntimeProviderAuth({
    cfg,
    provider,
    secretSentinels: params.secretSentinels,
  });
  if (
    managedRuntimeAuth &&
    isAuthModeAllowedForModel({
      provider,
      modelApi: params.modelApi,
      mode: managedRuntimeAuth.mode,
    })
  ) {
    return managedRuntimeAuth;
  }

  const customKey = authConfig.resolveUsableCustomProviderApiKey({
    cfg,
    provider,
    secretSentinels: params.secretSentinels,
  });
  if (customKey) {
    const mode = authConfig.resolveDirectProviderCredentialMode({
      cfg,
      provider,
      inferredMode: "api-key",
    });
    if (isAuthModeAllowedForModel({ provider, modelApi: params.modelApi, mode })) {
      return { apiKey: customKey.apiKey, source: customKey.source, mode };
    }
  }

  if (deferredAuthProfileResult) {
    return deferredAuthProfileResult;
  }

  const syntheticLocalAuth = resolveSyntheticLocalProviderAuth({
    cfg,
    provider,
    modelApi: params.modelApi,
    secretSentinels: params.secretSentinels,
    allowPluginSyntheticAuth: params.allowAuthProfileFallback !== false,
  });
  if (syntheticLocalAuth) {
    return syntheticLocalAuth;
  }

  const hasInlineConfiguredModels =
    Array.isArray(providerConfig?.models) && providerConfig.models.length > 0;
  const owningPluginIds =
    params.allowAuthProfileFallback !== false && !hasInlineConfiguredModels
      ? resolveOwningPluginIdsForProviderRef({
          provider,
          config: cfg,
        })
      : undefined;
  if (owningPluginIds?.length) {
    const pluginMissingAuthMessage = buildProviderMissingAuthMessageWithPlugin({
      provider,
      config: cfg,
      context: {
        config: cfg,
        agentDir,
        env: process.env,
        provider,
        listProfileIds: (providerId) => listProfilesForProvider(store, providerId),
      },
    });
    if (pluginMissingAuthMessage) {
      throw new ProviderAuthError("missing-provider-auth", provider, pluginMissingAuthMessage);
    }
  }

  const authStorePath = resolveAuthStorePathForDisplay(agentDir);
  const resolvedAgentDir = path.dirname(authStorePath);
  throw new ProviderAuthError(
    "missing-provider-auth",
    provider,
    [
      `No API key found for provider "${provider}".`,
      `Auth store: ${authStorePath} (agentDir: ${resolvedAgentDir}).`,
      `Configure auth for this agent (${formatCliCommand("openclaw agents add <id>")}) or copy only portable static auth profiles from the main agentDir.`,
    ].join(" "),
  );
}
