/**
 * Snapshot-aware and synthetic provider-auth availability.
 */
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderSyntheticAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveRuntimeSyntheticAuthProviderRefState } from "../plugins/synthetic-auth.runtime.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { resolveProviderEnvAuthLookupMaps } from "./model-auth-env-vars.js";
import { resolveEnvApiKey, type EnvApiKeyLookupOptions } from "./model-auth-env.js";
import { CUSTOM_LOCAL_AUTH_MARKER, isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { isAuthModeAllowedForModel } from "./model-auth-openai.js";
import * as authConfig from "./model-auth-provider-config.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { normalizeProviderId } from "./model-selection.js";

/** Precomputed provider-auth lookup tables reused during one runtime turn. */
export type RuntimeProviderAuthLookup = {
  envApiKey: Pick<
    EnvApiKeyLookupOptions,
    "aliasMap" | "candidateMap" | "authEvidenceMap" | "skipSetupProviderFallback"
  >;
  setupProviderFallbackRefs?: readonly string[];
  syntheticAuthProviderRefs?: readonly string[];
  syntheticAuthProviderRefsComplete?: boolean;
};

/** Builds stable env/synthetic auth lookup data for repeated provider checks. */
export function createRuntimeProviderAuthLookup(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includePluginSyntheticAuth?: boolean;
}): RuntimeProviderAuthLookup {
  const env = params.env ?? process.env;
  const lookupParams = {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env,
  };
  const syntheticAuthProviderRefs =
    params.includePluginSyntheticAuth === false
      ? undefined
      : resolveRuntimeSyntheticAuthProviderRefState(lookupParams);
  const authLookupMaps = resolveProviderEnvAuthLookupMaps(lookupParams);
  return {
    envApiKey: {
      aliasMap: authLookupMaps.aliasMap,
      candidateMap: authLookupMaps.envCandidateMap,
      authEvidenceMap: authLookupMaps.authEvidenceMap,
      skipSetupProviderFallback: true,
    },
    setupProviderFallbackRefs: authLookupMaps.setupProviderFallbackRefs,
    syntheticAuthProviderRefs: syntheticAuthProviderRefs?.complete
      ? syntheticAuthProviderRefs.refs
      : undefined,
    syntheticAuthProviderRefsComplete: syntheticAuthProviderRefs?.complete,
  };
}

function runtimeLookupAllowsSetupProviderFallback(params: {
  provider: string;
  runtimeLookup?: RuntimeProviderAuthLookup;
}): boolean {
  const refs = params.runtimeLookup?.setupProviderFallbackRefs;
  if (!refs?.length) {
    return false;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  const aliasTarget = params.runtimeLookup?.envApiKey.aliasMap?.[normalizedProvider];
  return refs.includes(normalizedProvider) || (aliasTarget ? refs.includes(aliasTarget) : false);
}

function resolveRuntimeEnvApiKeyLookupOptions(params: {
  provider: string;
  runtimeLookup?: RuntimeProviderAuthLookup;
}):
  | Pick<
      EnvApiKeyLookupOptions,
      "aliasMap" | "candidateMap" | "authEvidenceMap" | "skipSetupProviderFallback"
    >
  | undefined {
  const envApiKey = params.runtimeLookup?.envApiKey;
  if (!envApiKey) {
    return undefined;
  }
  const skipSetupProviderFallback =
    envApiKey.skipSetupProviderFallback === true
      ? !runtimeLookupAllowsSetupProviderFallback(params)
      : envApiKey.skipSetupProviderFallback;
  return {
    ...envApiKey,
    ...(skipSetupProviderFallback !== undefined ? { skipSetupProviderFallback } : {}),
  };
}

/** Reads a literal or env-secret marker for a custom provider entry. */
export function resolveManagedSecretRefRuntimeProviderAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  secretSentinels?: boolean;
}): ResolvedProviderAuth | undefined {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (params.cfg && params.cfg !== runtimeConfig && !runtimeSourceConfig) {
    return undefined;
  }
  const applicableConfig = selectApplicableRuntimeConfig({
    inputConfig: params.cfg,
    runtimeConfig,
    runtimeSourceConfig,
  });
  const usesRuntimeProvider =
    applicableConfig === runtimeConfig ||
    authConfig.providerConfigMatchesRuntimeSnapshot({
      inputConfig: params.cfg,
      runtimeConfig,
      provider: params.provider,
    });
  const sourceConfig = usesRuntimeProvider ? (runtimeSourceConfig ?? undefined) : params.cfg;
  if (!authConfig.hasSecretRefProviderApiKey(sourceConfig, params.provider)) {
    return undefined;
  }
  if (!runtimeConfig || !usesRuntimeProvider) {
    return undefined;
  }
  const resolved = authConfig.resolveLiteralProviderConfigApiKeyAuth({
    cfg: runtimeConfig,
    provider: params.provider,
  });
  if (!resolved?.apiKey) {
    return undefined;
  }
  return {
    ...resolved,
    apiKey: params.secretSentinels
      ? mintSecretSentinel(resolved.apiKey, {
          label: `model-auth:${params.provider}`,
        })
      : resolved.apiKey,
  };
}

export function assertRuntimeProviderSecretOwnerAvailable(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): void {
  const provider = normalizeProviderId(params.provider);
  const degraded = findActiveDegradedSecretOwner("provider", provider);
  if (!degraded) {
    return;
  }
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  const usesRuntimeProvider =
    !params.cfg ||
    params.cfg === runtimeConfig ||
    params.cfg === runtimeSourceConfig ||
    authConfig.providerConfigMatchesRuntimeSnapshot({
      inputConfig: params.cfg,
      runtimeConfig,
      provider,
    });
  if (usesRuntimeProvider) {
    throw new SecretSurfaceUnavailableError(degraded);
  }
}

/** True when a custom local provider can use a synthetic no-auth placeholder. */
export function hasSyntheticLocalProviderAuthConfig(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): boolean {
  const providerConfig = authConfig.resolveProviderConfig(params.cfg, params.provider);
  if (!providerConfig) {
    return false;
  }

  const hasApiConfig =
    Boolean(providerConfig.api?.trim()) ||
    Boolean(providerConfig.baseUrl?.trim()) ||
    (Array.isArray(providerConfig.models) && providerConfig.models.length > 0);
  if (!hasApiConfig) {
    return false;
  }

  const authOverride = authConfig.resolveProviderAuthOverride(params.cfg, params.provider);
  if (authOverride && authOverride !== "api-key") {
    return false;
  }
  if (!authConfig.isCustomLocalProviderConfig(providerConfig)) {
    return false;
  }
  if (authConfig.hasExplicitProviderApiKeyConfig(providerConfig)) {
    return false;
  }
  return Boolean(
    providerConfig.baseUrl && authConfig.isLocalAuthProviderBaseUrl(providerConfig.baseUrl),
  );
}

function listProviderSyntheticAuthRefs(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelApi?: string;
}): string[] {
  const refs = [params.provider];
  const providerConfig = authConfig.resolveProviderConfig(params.cfg, params.provider);
  if (params.modelApi) {
    refs.push(params.modelApi);
  }
  if (providerConfig?.api) {
    refs.push(providerConfig.api);
  }
  return normalizeUniqueStringEntries(refs.map((ref) => normalizeProviderId(ref)));
}

function shouldResolvePluginSyntheticAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelApi?: string;
  runtimeLookup?: RuntimeProviderAuthLookup;
}): boolean {
  const syntheticAuthProviderRefs = params.runtimeLookup?.syntheticAuthProviderRefs;
  if (!syntheticAuthProviderRefs) {
    return true;
  }
  const eligibleRefs = new Set(
    normalizeUniqueStringEntries(syntheticAuthProviderRefs.map((ref) => normalizeProviderId(ref))),
  );
  if (eligibleRefs.size === 0) {
    return false;
  }
  return listProviderSyntheticAuthRefs(params).some((ref) => eligibleRefs.has(ref));
}

/** Fast auth-availability check for runtime provider/model selection. */
export function hasRuntimeAvailableProviderAuth(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  runtimeLookup?: RuntimeProviderAuthLookup;
  modelApi?: string;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  const authOverride = authConfig.resolveProviderAuthOverride(params.cfg, provider);
  if (authOverride === "aws-sdk") {
    return true;
  }
  const envAuth = resolveEnvApiKey(provider, params.env, {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    ...resolveRuntimeEnvApiKeyLookupOptions({
      provider,
      runtimeLookup: params.runtimeLookup,
    }),
  });
  if (
    envAuth &&
    isAuthModeAllowedForModel({
      provider,
      modelApi: params.modelApi,
      mode: envAuth.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
    })
  ) {
    return true;
  }
  if (
    authConfig.resolveUsableCustomProviderApiKey({
      cfg: params.cfg,
      provider,
      env: params.env,
    })
  ) {
    return true;
  }
  if (resolveManagedSecretRefRuntimeProviderAuth({ cfg: params.cfg, provider })) {
    return true;
  }
  if (hasSyntheticLocalProviderAuthConfig({ cfg: params.cfg, provider })) {
    return true;
  }
  if (
    params.allowPluginSyntheticAuth !== false &&
    shouldResolvePluginSyntheticAuth({
      cfg: params.cfg,
      provider,
      runtimeLookup: params.runtimeLookup,
    }) &&
    resolveSyntheticLocalProviderAuth({ cfg: params.cfg, provider })
  ) {
    return true;
  }
  return false;
}

type SyntheticProviderAuthResolution = {
  auth?: ResolvedProviderAuth;
  blockedOnManagedSecretRef?: boolean;
};

function resolveProviderSyntheticRuntimeAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelApi?: string;
  secretSentinels?: boolean;
}): SyntheticProviderAuthResolution {
  const runtimeAuth = resolveManagedSecretRefRuntimeProviderAuth(params);
  if (runtimeAuth) {
    return { auth: runtimeAuth };
  }
  if (authConfig.hasSecretRefProviderApiKey(params.cfg, params.provider)) {
    return { blockedOnManagedSecretRef: true };
  }

  const resolveFromConfig = (
    config: OpenClawConfig | undefined,
  ): ResolvedProviderAuth | undefined => {
    const providerConfig = authConfig.resolveProviderConfig(config, params.provider);
    return (
      resolveProviderSyntheticAuthWithPlugin({
        provider: params.provider,
        config,
        context: {
          config,
          provider: params.provider,
          providerConfig,
        },
        modelApi: params.modelApi,
      }) ?? undefined
    );
  };

  const directAuth = resolveFromConfig(params.cfg);
  if (!directAuth) {
    return {};
  }
  if (!authConfig.isManagedSecretRefApiKeyMarker(directAuth.apiKey)) {
    return { auth: directAuth };
  }

  const runtimeConfig = getRuntimeConfigSnapshot();
  if (!runtimeConfig || runtimeConfig === params.cfg) {
    return { blockedOnManagedSecretRef: true };
  }

  const runtimePluginAuth = resolveFromConfig(runtimeConfig);
  const runtimeApiKey = runtimePluginAuth?.apiKey;
  if (!runtimePluginAuth || !runtimeApiKey || isNonSecretApiKeyMarker(runtimeApiKey)) {
    return { blockedOnManagedSecretRef: true };
  }
  return {
    auth: {
      ...runtimePluginAuth,
      apiKey: params.secretSentinels
        ? mintSecretSentinel(runtimeApiKey, {
            label: `model-auth:${params.provider}`,
          })
        : runtimeApiKey,
    },
  };
}

export function resolveSyntheticLocalProviderAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelApi?: string;
  secretSentinels?: boolean;
  allowPluginSyntheticAuth?: boolean;
}): ResolvedProviderAuth | null {
  // Prepared direct attempts may use local no-auth config, but must not widen
  // back into an unprepared plugin-owned credential source.
  const syntheticProviderAuth =
    params.allowPluginSyntheticAuth === false ? {} : resolveProviderSyntheticRuntimeAuth(params);
  if (syntheticProviderAuth.auth) {
    return syntheticProviderAuth.auth;
  }
  if (syntheticProviderAuth.blockedOnManagedSecretRef) {
    return null;
  }

  const providerConfig = authConfig.resolveProviderConfig(params.cfg, params.provider);
  if (!providerConfig) {
    return null;
  }

  // Custom providers pointing at a local server (e.g. llama.cpp, vLLM, LocalAI)
  // typically don't require auth. Synthesize a local key so the auth resolver
  // doesn't reject them when the user left the API key blank during setup.
  if (hasSyntheticLocalProviderAuthConfig(params)) {
    return {
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: `models.providers.${params.provider} (synthetic local key)`,
      mode: "api-key",
    };
  }

  return null;
}
