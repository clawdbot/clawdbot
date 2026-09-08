/**
 * Ordered credential resolution for one provider request.
 */
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildProviderMissingAuthMessageWithPlugin,
  resolveProviderDeprecatedAuthProfileIds,
  shouldDeferProviderSyntheticProfileAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveOwningPluginIdsForProviderRef } from "../plugins/providers.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { resolveUserPath } from "../utils.js";
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
import { assertAuthProfileMigrationReady } from "./auth-profiles/legacy-source-diagnostic.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { assertAuthModeAllowedForModel, isAuthModeAllowedForModel } from "./model-auth-openai.js";
import * as authConfig from "./model-auth-provider-config.js";
import {
  assertRuntimeProviderSecretOwnerAvailable,
  resolveManagedSecretRefRuntimeProviderAuth,
} from "./model-auth-runtime-config.js";
import {
  ProviderAuthError,
  resolveDirectProviderCredentialMode,
  type ResolvedProviderAuth,
} from "./model-auth-runtime-shared.js";
import { prepareSyntheticLocalProviderAuth } from "./model-auth-runtime.js";

export type ProviderCredentialPrecedence = "profile-first" | "env-first";

const log = createSubsystemLogger("model-auth");

function assertAuthProfileNotRetired(params: {
  profileId: string;
  deprecatedProfileIds: ReadonlySet<string>;
}): void {
  if (!params.deprecatedProfileIds.has(params.profileId)) {
    return;
  }
  throw new Error(
    `Auth profile "${params.profileId}" is retired. Run ${formatCliCommand("openclaw doctor --fix")}.`,
  );
}

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
    profileId: params.profileId,
    externalCli: externalCliDiscoveryForProviderAuth(params),
  });
}

function assertProviderAuthReady(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): void {
  // Pending credential files own this agent's auth route until Doctor commits
  // and archives them; do not fall through to env/config credentials.
  assertAuthProfileMigrationReady(params.agentDir);
  // A failed explicit ref owns the provider. Stop before profile/env discovery so requests cannot
  // silently switch credentials while this configured owner is cold.
  assertRuntimeProviderSecretOwnerAvailable({ cfg: params.cfg, provider: params.provider });
}

/** Resolves a stored provider-entry binding without general credential discovery. */
export async function resolveProviderEntryApiKeyAuth(params: {
  provider: string;
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  agentDir?: string;
  modelApi?: string;
  secretSentinels?: boolean;
}): Promise<ResolvedProviderAuth | undefined> {
  const { provider, cfg } = params;
  assertProviderAuthReady(params);
  const reference = authConfig.resolveProviderEntryApiKeyProfileReference(params);
  if (!("profileId" in reference)) {
    return undefined;
  }
  assertAuthProfileNotRetired({
    profileId: reference.profileId,
    deprecatedProfileIds: new Set(
      resolveProviderDeprecatedAuthProfileIds({ provider, config: cfg }),
    ),
  });
  // A matched binding is terminal: never replace a bad profile with a different
  // credential or send the profile id as literal bearer text.
  const binding = await authConfig.resolveProviderEntryApiKeyBinding(params);
  if (binding.kind === "profile-resolved") {
    assertAuthModeAllowedForModel({
      provider,
      modelApi: params.modelApi,
      profileId: binding.auth.profileId ?? provider,
      mode: binding.auth.mode,
    });
    return binding.auth;
  }
  if (binding.kind === "profile-incompatible") {
    const reason =
      binding.reason === "credential-class"
        ? "which is not a bearer-style auth class"
        : "which is not compatible with this provider entry's auth binding";
    const action =
      binding.reason === "credential-class"
        ? "Use an api-key or token profile, or set apiKey to a literal bearer token."
        : "Use a compatible provider auth alias, configure the referenced provider entry with the same baseUrl, or set apiKey to a literal bearer token.";
    throw new Error(
      `Per-entry apiKey "${binding.profileId}" for provider "${provider}" references a "${binding.credentialType}" credential for provider "${binding.credentialProvider}", ${reason}. ${action}`,
    );
  }
  if (binding.kind === "profile-unresolved") {
    const cause = binding.error
      ? formatErrorMessage(binding.error)
      : "credential resolution returned no key";
    throw new Error(
      `Per-entry apiKey "${binding.profileId}" for provider "${provider}" matched a stored profile but failed to resolve: ${cause}. Fix the referenced profile or set apiKey to a literal bearer token.`,
    );
  }
  return undefined;
}

/** Resolves the credential that should be used for one provider request. */
export async function resolveApiKeyForProviderCore(params: {
  provider: string;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  /** When true, treat profileId as a user-locked selection that must not be
   *  silently replaced by another profile or env/config credentials. */
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
  let deprecatedProfileIds: ReadonlySet<string> | undefined;
  const getDeprecatedProfileIds = () =>
    (deprecatedProfileIds ??= new Set(
      resolveProviderDeprecatedAuthProfileIds({ provider, config: cfg }),
    ));
  const agentDir = params.agentDir?.trim() || (cfg ? resolveDefaultAgentDir(cfg) : undefined);
  assertProviderAuthReady({ cfg, provider, agentDir });
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
    assertAuthProfileNotRetired({
      profileId,
      deprecatedProfileIds: getDeprecatedProfileIds(),
    });
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
      allowProfileFallback: !params.lockedProfile,
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
      return resolveApiKeyForProviderCore({
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
      const resolvedMode = resolveDirectProviderCredentialMode({
        cfg,
        provider,
        inferredMode: envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
      });
      if (resolvedMode === "api-key") {
        const inlineStore = getScopedStore();
        if (
          authConfig.isConfigBackedInlineProviderApiKey({
            cfg,
            provider,
            source: envResolved.source,
            store: inlineStore,
          })
        ) {
          authConfig.assertInlineProviderApiKeyUsable({ store: inlineStore, provider });
        }
      }
      if (
        !isAuthModeAllowedForModel({
          provider,
          modelApi: params.modelApi,
          mode: resolvedMode,
        })
      ) {
        return resolveApiKeyForProviderCore({ ...params, credentialPrecedence: "profile-first" });
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

  // General model auth keeps its AWS/env precedence ahead of per-entry bindings.
  const providerEntryAuth = await resolveProviderEntryApiKeyAuth({
    cfg,
    provider,
    store: getScopedStore(),
    agentDir,
    modelApi: params.modelApi,
    secretSentinels: params.secretSentinels,
  });
  if (providerEntryAuth) {
    return providerEntryAuth;
  }

  if (authConfig.shouldPreferExplicitConfigApiKeyAuth(cfg, provider)) {
    const runtimeCustomKey = resolveManagedSecretRefRuntimeProviderAuth({
      cfg,
      provider,
      secretSentinels: params.secretSentinels,
    });
    if (runtimeCustomKey) {
      // Managed (file/exec) SecretRef provider keys are config-backed inline
      // credentials too, so they must honor the inline-key cooldown gate just
      // like the literal/env paths below — otherwise a 402 cooldown is recorded
      // but never enforced for these keys.
      authConfig.assertInlineProviderApiKeyUsable({ store: getScopedStore(), provider });
      return runtimeCustomKey;
    }
    const customKey = authConfig.resolveUsableCustomProviderApiKey({
      cfg,
      provider,
      secretSentinels: params.secretSentinels,
    });
    if (customKey) {
      authConfig.assertInlineProviderApiKeyUsable({ store: getScopedStore(), provider });
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
    const candidateType = store.profiles[candidate]?.type;
    const candidateMode = candidateType
      ? authConfig.profileTypeToAuthMode(candidateType)
      : undefined;
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
    if (getDeprecatedProfileIds().has(candidate)) {
      continue;
    }
    try {
      const awsSdkProfileAuth = authConfig.resolveConfiguredAwsSdkProfileAuth({
        cfg,
        provider,
        profileId: candidate,
      });
      if (awsSdkProfileAuth) {
        return awsSdkProfileAuth;
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
    const resolvedMode = resolveDirectProviderCredentialMode({
      cfg,
      provider,
      inferredMode: envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
    });
    if (resolvedMode === "api-key") {
      const inlineStore = getScopedStore();
      if (
        authConfig.isConfigBackedInlineProviderApiKey({
          cfg,
          provider,
          source: envResolved.source,
          store: inlineStore,
        })
      ) {
        authConfig.assertInlineProviderApiKeyUsable({ store: inlineStore, provider });
      }
    }
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
    const inlineStore = getScopedStore();
    if (
      authConfig.isConfigBackedInlineProviderApiKey({
        cfg,
        provider,
        source: managedRuntimeAuth.source,
        store: inlineStore,
      })
    ) {
      authConfig.assertInlineProviderApiKeyUsable({ store: inlineStore, provider });
    }
    return managedRuntimeAuth;
  }

  const customKey = authConfig.resolveUsableCustomProviderApiKey({
    cfg,
    provider,
    secretSentinels: params.secretSentinels,
  });
  if (customKey) {
    const mode = resolveDirectProviderCredentialMode({
      cfg,
      provider,
      inferredMode: "api-key",
    });
    if (isAuthModeAllowedForModel({ provider, modelApi: params.modelApi, mode })) {
      authConfig.assertInlineProviderApiKeyUsable({ store: getScopedStore(), provider });
      return { apiKey: customKey.apiKey, source: customKey.source, mode };
    }
  }

  if (deferredAuthProfileResult) {
    return deferredAuthProfileResult;
  }

  const syntheticLocalAuth = await prepareSyntheticLocalProviderAuth({
    cfg,
    provider,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
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
      throw new ProviderAuthError("missing-provider-auth", provider, pluginMissingAuthMessage, {
        providerGuidance: true,
      });
    }
  }

  const authStorePath = resolveAuthStorePathForDisplay(agentDir);
  const agentDirContext = agentDir ? ` (agentDir: ${resolveUserPath(agentDir)})` : "";
  throw new ProviderAuthError(
    "missing-provider-auth",
    provider,
    [
      `No API key found for provider "${provider}".`,
      `Auth store: ${authStorePath}${agentDirContext}.`,
      `Configure an API key (${formatCliCommand(`openclaw models auth paste-api-key --provider ${provider}`)}; add --agent <id> for a non-default agent) or copy only portable static auth profiles from the main agentDir.`,
    ].join(" "),
  );
}
