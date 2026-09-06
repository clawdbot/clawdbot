/**
 * Snapshot-aware and synthetic provider-auth availability.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareProviderSyntheticAuthWithPlugin,
  resolveProviderSyntheticAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveRuntimeSyntheticAuthProviderRefState } from "../plugins/synthetic-auth.runtime.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { resolveProviderEnvAuthLookupMaps } from "./model-auth-env-vars.js";
import { resolveEnvApiKey, type EnvApiKeyLookupOptions } from "./model-auth-env.js";
import { CUSTOM_LOCAL_AUTH_MARKER, isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { isAuthModeAllowedForModel } from "./model-auth-openai.js";
import * as authConfig from "./model-auth-provider-config.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "./model-auth-runtime-config.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

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

type RuntimeProviderAuthParams = {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  runtimeLookup?: RuntimeProviderAuthLookup;
  modelApi?: string;
  store?: AuthProfileStore;
};

function resolveRuntimeAvailableProviderAuth<T>(
  params: RuntimeProviderAuthParams,
  resolveSyntheticAuth: (provider: string) => T,
): boolean | T {
  const provider = normalizeProviderId(params.provider);
  const authOverride = authConfig.resolveProviderAuthOverride(params.cfg, provider);
  if (authOverride === "aws-sdk") {
    return true;
  }

  // Callers that supply the auth store get inline provider keys hidden while
  // their billing/auth cooldown is active, so browse and tool selection stop
  // advertising a credential the resolver would refuse to hand back.
  const inlineProviderApiKeyUsable = params.store
    ? (() => {
        const unusableUntil = authConfig.resolveInlineProviderApiKeyCooldownUntil(
          params.store,
          provider,
        );
        return unusableUntil === null || unusableUntil <= Date.now();
      })()
    : true;

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
    }) &&
    (!authConfig.isConfigBackedInlineProviderApiKey({
      cfg: params.cfg,
      provider,
      source: envAuth.source,
      store: params.store,
    }) ||
      inlineProviderApiKeyUsable)
  ) {
    return true;
  }
  if (
    authConfig.resolveUsableCustomProviderApiKey({
      cfg: params.cfg,
      provider,
      env: params.env,
    }) &&
    inlineProviderApiKeyUsable
  ) {
    return true;
  }
  const managedRuntimeAuth = resolveManagedSecretRefRuntimeProviderAuth({
    cfg: params.cfg,
    provider,
  });
  if (
    managedRuntimeAuth &&
    (!authConfig.isConfigBackedInlineProviderApiKey({
      cfg: params.cfg,
      provider,
      source: managedRuntimeAuth.source,
      store: params.store,
    }) ||
      inlineProviderApiKeyUsable)
  ) {
    return true;
  }
  if (authConfig.hasSyntheticLocalProviderAuthConfig({ cfg: params.cfg, provider })) {
    return true;
  }
  if (
    params.allowPluginSyntheticAuth !== false &&
    shouldResolvePluginSyntheticAuth({
      cfg: params.cfg,
      provider,
      runtimeLookup: params.runtimeLookup,
    })
  ) {
    return resolveSyntheticAuth(provider);
  }
  return false;
}

/** Fast auth-availability check for runtime provider/model selection. */
export function hasRuntimeAvailableProviderAuth(params: RuntimeProviderAuthParams): boolean {
  return resolveRuntimeAvailableProviderAuth(params, (provider) =>
    Boolean(
      resolveSyntheticLocalProviderAuth({
        cfg: params.cfg,
        provider,
        workspaceDir: params.workspaceDir,
        env: params.env,
      }),
    ),
  );
}

/** Prepare external auth only after immediate credentials and discovery scope permit it. */
export async function prepareRuntimeAvailableProviderAuth(
  params: RuntimeProviderAuthParams & { signal?: AbortSignal },
): Promise<boolean> {
  params.signal?.throwIfAborted();
  return resolveRuntimeAvailableProviderAuth(params, async (provider) =>
    Boolean(await prepareSyntheticLocalProviderAuth({ ...params, cfg: params.cfg, provider })),
  );
}

type SyntheticProviderAuthResolution = {
  auth?: ResolvedProviderAuth;
  blockedOnManagedSecretRef?: boolean;
};

type SyntheticProviderAuthParams = {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelApi?: string;
  secretSentinels?: boolean;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
};

type ResolveSyntheticProviderAuth = (
  config: OpenClawConfig | undefined,
) => ResolvedProviderAuth | undefined;

function syntheticAuthLookup(
  params: SyntheticProviderAuthParams,
  config: OpenClawConfig | undefined,
) {
  return {
    provider: params.provider,
    config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    modelApi: params.modelApi,
    context: {
      config,
      provider: params.provider,
      providerConfig: authConfig.resolveProviderConfig(config, params.provider),
    },
  };
}

function resolveProviderSyntheticRuntimeAuth(
  params: SyntheticProviderAuthParams,
  resolveFromConfig: ResolveSyntheticProviderAuth = (config) =>
    resolveProviderSyntheticAuthWithPlugin(syntheticAuthLookup(params, config)),
): SyntheticProviderAuthResolution {
  const runtimeAuth = resolveManagedSecretRefRuntimeProviderAuth(params);
  if (runtimeAuth) {
    return { auth: runtimeAuth };
  }
  if (authConfig.hasSecretRefProviderApiKey(params.cfg, params.provider)) {
    return { blockedOnManagedSecretRef: true };
  }

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

/** Prepare native readiness without widening explicit managed-credential authority. */
export async function prepareSyntheticLocalProviderAuth(
  params: SyntheticProviderAuthParams & { signal?: AbortSignal },
): Promise<ResolvedProviderAuth | null> {
  if (
    params.allowPluginSyntheticAuth === false ||
    authConfig.hasSecretRefProviderApiKey(params.cfg, params.provider)
  ) {
    return resolveSyntheticLocalProviderAuth(params);
  }
  const prepare = (config: OpenClawConfig | undefined) =>
    prepareProviderSyntheticAuthWithPlugin({
      ...syntheticAuthLookup(params, config),
      signal: params.signal,
    });
  const direct = await prepare(params.cfg);
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeAuth =
    direct &&
    authConfig.isManagedSecretRefApiKeyMarker(direct.apiKey) &&
    runtimeConfig &&
    runtimeConfig !== params.cfg
      ? await prepare(runtimeConfig)
      : undefined;
  // Consume the exact completed results, including absence. A second lookup can
  // change provider identity or repeat a pure hook; a replaced runtime config has no fact.
  return resolveSyntheticLocalProviderAuth(params, (config) =>
    config === params.cfg ? direct : config === runtimeConfig ? runtimeAuth : undefined,
  );
}

function resolveSyntheticLocalProviderAuth(
  params: SyntheticProviderAuthParams,
  resolveFromConfig?: ResolveSyntheticProviderAuth,
): ResolvedProviderAuth | null {
  // Prepared direct attempts may use local no-auth config, but must not widen
  // back into an unprepared plugin-owned credential source.
  const syntheticProviderAuth =
    params.allowPluginSyntheticAuth === false
      ? {}
      : resolveProviderSyntheticRuntimeAuth(params, resolveFromConfig);
  if (syntheticProviderAuth.auth) {
    return syntheticProviderAuth.auth;
  }
  if (syntheticProviderAuth.blockedOnManagedSecretRef) {
    return null;
  }

  // Custom providers pointing at a local server (e.g. llama.cpp, vLLM, LocalAI)
  // typically don't require auth. Synthesize a local key so the auth resolver
  // doesn't reject them when the user left the API key blank during setup.
  if (authConfig.hasSyntheticLocalProviderAuthConfig(params)) {
    return {
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: `models.providers.${params.provider} (synthetic local key)`,
      mode: "api-key",
    };
  }

  return null;
}
