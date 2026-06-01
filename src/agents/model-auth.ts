import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfigSnapshot } from "../config/config.js";
import type { ModelProviderAuthMode, ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildProviderMissingAuthMessageWithPlugin,
  resolveProviderSyntheticAuthWithPlugin,
  shouldDeferProviderSyntheticProfileAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveOwningPluginIdsForProviderRef } from "../plugins/providers.js";
import { resolveRuntimeSyntheticAuthProviderRefState } from "../plugins/synthetic-auth.runtime.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { resolveDefaultAgentDir } from "./agent-scope-config.js";
import {
  type AuthProfileCredential,
  type AuthProfileStore,
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  isConfiguredAwsSdkAuthProfileForProvider,
  isStoredCredentialCompatibleWithAuthProvider,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  resolveAuthStorePathForDisplay,
} from "./auth-profiles.js";
import * as cliCredentials from "./cli-credentials.js";
import { resolveProviderEnvAuthLookupMaps } from "./model-auth-env-vars.js";
import {
  resolveEnvApiKey,
  type EnvApiKeyLookupOptions,
  type EnvApiKeyResult,
} from "./model-auth-env.js";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
} from "./model-auth-markers.js";
import { ProviderAuthError, type ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { normalizeProviderId } from "./model-selection.js";

export {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
export {
  formatMissingAuthError,
  isProviderAuthError,
  ProviderAuthError,
  requireApiKey,
  resolveAwsSdkEnvVarName,
} from "./model-auth-runtime-shared.js";
export type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
export type ProviderCredentialPrecedence = "profile-first" | "env-first";

export type RuntimeProviderAuthLookup = {
  envApiKey: Pick<
    EnvApiKeyLookupOptions,
    "aliasMap" | "candidateMap" | "authEvidenceMap" | "skipSetupProviderFallback"
  >;
  setupProviderFallbackRefs?: readonly string[];
  syntheticAuthProviderRefs?: readonly string[];
  syntheticAuthProviderRefsComplete?: boolean;
};

const log = createSubsystemLogger("model-auth");
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_RESPONSES_API = "openai-chatgpt-responses";

function directOpenAIPlatformModelRequiresApiKey(params: {
  provider: string;
  modelApi?: string;
}): boolean {
  return (
    normalizeProviderId(params.provider) === OPENAI_PROVIDER_ID &&
    params.modelApi !== undefined &&
    normalizeLowercaseStringOrEmpty(params.modelApi) !== OPENAI_CODEX_RESPONSES_API
  );
}

function isAuthModeAllowedForModel(params: {
  provider: string;
  modelApi?: string;
  mode: ResolvedProviderAuth["mode"];
}): boolean {
  return !directOpenAIPlatformModelRequiresApiKey(params) || params.mode === "api-key";
}

function assertAuthModeAllowedForModel(params: {
  provider: string;
  modelApi?: string;
  profileId: string;
  mode: ResolvedProviderAuth["mode"];
}): void {
  if (isAuthModeAllowedForModel(params)) {
    return;
  }
  throw new Error(
    `Auth profile "${params.profileId}" uses ${params.mode} auth, but ${params.provider}/${params.modelApi} requires an OpenAI API key profile.`,
  );
}

function resolveConfigAwareEnvApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
  workspaceDir?: string,
): EnvApiKeyResult | null {
  return resolveEnvApiKey(provider, process.env, { config: cfg, workspaceDir });
}

function resolveProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  const providers = cfg?.models?.providers ?? {};
  const direct = providers[provider] as ModelProviderConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(provider);
  if (normalized === provider) {
    const matched = Object.entries(providers).find(
      ([key]) => normalizeProviderId(key) === normalized,
    );
    return matched?.[1];
  }
  return (
    (providers[normalized] as ModelProviderConfig | undefined) ??
    Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1]
  );
}

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

export function getCustomProviderApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  const entry = resolveProviderConfig(cfg, provider);
  const literal = normalizeOptionalSecretInput(entry?.apiKey);
  if (literal) {
    return literal;
  }
  const ref = coerceSecretRef(entry?.apiKey);
  if (!ref) {
    return undefined;
  }
  if (ref.source === "env") {
    const envId = ref.id.trim();
    return envId || NON_ENV_SECRETREF_MARKER;
  }
  return NON_ENV_SECRETREF_MARKER;
}

type ResolvedCustomProviderApiKey = {
  apiKey: string;
  source: string;
};

function canResolveEnvSecretRefInReadOnlyPath(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  id: string;
}): boolean {
  const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
  if (!providerConfig) {
    return params.provider === resolveDefaultSecretProviderAlias(params.cfg ?? {}, "env");
  }
  if (providerConfig.source !== "env") {
    return false;
  }
  const allowlist = providerConfig.allowlist;
  return !allowlist || allowlist.includes(params.id);
}

export function resolveUsableCustomProviderApiKey(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedCustomProviderApiKey | null {
  const customProviderConfig = resolveProviderConfig(params.cfg, params.provider);
  const apiKeyRef = coerceSecretRef(customProviderConfig?.apiKey);
  if (apiKeyRef) {
    if (apiKeyRef.source !== "env") {
      return null;
    }
    const envVarName = apiKeyRef.id.trim();
    if (!envVarName) {
      return null;
    }
    if (
      !canResolveEnvSecretRefInReadOnlyPath({
        cfg: params.cfg,
        provider: apiKeyRef.provider,
        id: envVarName,
      })
    ) {
      return null;
    }
    const envValue = normalizeOptionalSecretInput((params.env ?? process.env)[envVarName]);
    if (!envValue) {
      return null;
    }
    const applied = new Set(getShellEnvAppliedKeys());
    return {
      apiKey: envValue,
      source: resolveEnvSourceLabel({
        applied,
        envVars: [envVarName],
        label: `${envVarName} (models.json secretref)`,
      }),
    };
  }

  const customKey = getCustomProviderApiKey(params.cfg, params.provider);
  if (!customKey) {
    return null;
  }
  if (!isNonSecretApiKeyMarker(customKey)) {
    return { apiKey: customKey, source: "models.json" };
  }
  if (isKnownEnvApiKeyMarker(customKey)) {
    const envValue = normalizeOptionalSecretInput((params.env ?? process.env)[customKey]);
    if (!envValue) {
      return null;
    }
    const applied = new Set(getShellEnvAppliedKeys());
    return {
      apiKey: envValue,
      source: resolveEnvSourceLabel({
        applied,
        envVars: [customKey],
        label: `${customKey} (models.json marker)`,
      }),
    };
  }
  if (
    customProviderConfig &&
    isCustomLocalProviderConfig(customProviderConfig) &&
    (customProviderConfig.api === "openai-completions" || customProviderConfig.api === "ollama") &&
    customProviderConfig.baseUrl &&
    isLocalBaseUrl(customProviderConfig.baseUrl)
  ) {
    return {
      apiKey: customProviderConfig.api === "ollama" ? customKey : CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.json (local marker)",
    };
  }
  return null;
}

export function hasUsableCustomProviderApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  return Boolean(resolveUsableCustomProviderApiKey({ cfg, provider, env }));
}

export function shouldPreferExplicitConfigApiKeyAuth(
  cfg: OpenClawConfig | undefined,
  provider: string,
): boolean {
  const providerConfig = resolveProviderConfig(cfg, provider);
  return (
    resolveProviderAuthOverride(cfg, provider) === "api-key" &&
    providerConfig !== undefined &&
    hasExplicitProviderApiKeyConfig(providerConfig)
  );
}

function resolveProviderAuthOverride(
  cfg: OpenClawConfig | undefined,
  provider: string,
): ModelProviderAuthMode | undefined {
  const entry = resolveProviderConfig(cfg, provider);
  const auth = entry?.auth;
  if (auth === "api-key" || auth === "aws-sdk" || auth === "oauth" || auth === "token") {
    return auth;
  }
  return undefined;
}

function shouldUseImplicitAwsSdkAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelApi: string | undefined;
}): boolean {
  if (params.modelApi !== "bedrock-converse-stream") {
    return false;
  }
  if (normalizeProviderId(params.provider) !== "amazon-bedrock") {
    return false;
  }
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
  return (
    resolveProviderAuthOverride(params.cfg, params.provider) === undefined &&
    (providerConfig === undefined || !hasExplicitProviderApiKeyConfig(providerConfig))
  );
}

function profileTypeToAuthMode(type: AuthProfileCredential["type"]): ResolvedProviderAuth["mode"] {
  return type === "oauth" ? "oauth" : type === "token" ? "token" : "api-key";
}

type ProviderEntryApiKeyProfileReference =
  | { kind: "none" }
  | { kind: "literal"; apiKey: string; source: string }
  | {
      kind: "profile";
      profileId: string;
      credential: AuthProfileCredential;
      mode: ResolvedProviderAuth["mode"];
    }
  | {
      kind: "profile-incompatible";
      profileId: string;
      credentialProvider: string;
      credentialType: AuthProfileCredential["type"];
      reason: "credential-class" | "provider-binding";
    }
  | { kind: "marker" };

export type ProviderEntryApiKeyBindingResolution =
  | { kind: "none" }
  | { kind: "literal"; apiKey: string; source: string }
  | { kind: "profile-resolved"; auth: ResolvedProviderAuth }
  | {
      kind: "profile-incompatible";
      profileId: string;
      credentialProvider: string;
      credentialType: AuthProfileCredential["type"];
      reason: "credential-class" | "provider-binding";
    }
  | { kind: "profile-unresolved"; profileId: string; error?: unknown };

function normalizeProviderEntryBaseUrlForBinding(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}

function providerEntriesShareBaseUrl(params: {
  cfg?: OpenClawConfig;
  provider: string;
  credentialProvider: string;
}): boolean {
  const providerBaseUrl = normalizeProviderEntryBaseUrlForBinding(
    resolveProviderConfig(params.cfg, params.provider)?.baseUrl,
  );
  const credentialProviderBaseUrl = normalizeProviderEntryBaseUrlForBinding(
    resolveProviderConfig(params.cfg, params.credentialProvider)?.baseUrl,
  );
  return Boolean(
    providerBaseUrl && credentialProviderBaseUrl && providerBaseUrl === credentialProviderBaseUrl,
  );
}

function isBearerProfileCredential(credential: AuthProfileCredential): boolean {
  return credential.type === "api_key" || credential.type === "token";
}

export function canUseProfileAsProviderEntryApiKey(params: {
  cfg?: OpenClawConfig;
  provider: string;
  credential: AuthProfileCredential;
}): boolean {
  if (!isBearerProfileCredential(params.credential)) {
    return false;
  }
  if (
    isStoredCredentialCompatibleWithAuthProvider({
      cfg: params.cfg,
      provider: params.provider,
      credential: params.credential,
    })
  ) {
    return true;
  }
  // Split-provider entries may intentionally point at the same upstream endpoint
  // with different profile ids. Require a matching configured base URL before
  // allowing a bearer profile to cross provider ids.
  return providerEntriesShareBaseUrl({
    cfg: params.cfg,
    provider: params.provider,
    credentialProvider: params.credential.provider,
  });
}

export function resolveProviderEntryApiKeyProfileReference(params: {
  cfg?: OpenClawConfig;
  provider: string;
  store: AuthProfileStore;
}): ProviderEntryApiKeyProfileReference {
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
  if (coerceSecretRef(providerConfig?.apiKey)) {
    return { kind: "none" };
  }
  const perEntryRawKey = normalizeOptionalSecretInput(providerConfig?.apiKey);
  if (!perEntryRawKey) {
    return { kind: "none" };
  }
  if (isNonSecretApiKeyMarker(perEntryRawKey)) {
    return { kind: "marker" };
  }
  const credential = params.store.profiles[perEntryRawKey];
  if (!credential) {
    return { kind: "literal", apiKey: perEntryRawKey, source: "models.json" };
  }
  if (!isBearerProfileCredential(credential)) {
    return {
      kind: "profile-incompatible",
      profileId: perEntryRawKey,
      credentialProvider: credential.provider,
      credentialType: credential.type,
      reason: "credential-class",
    };
  }
  if (
    !canUseProfileAsProviderEntryApiKey({ cfg: params.cfg, provider: params.provider, credential })
  ) {
    return {
      kind: "profile-incompatible",
      profileId: perEntryRawKey,
      credentialProvider: credential.provider,
      credentialType: credential.type,
      reason: "provider-binding",
    };
  }
  return {
    kind: "profile",
    profileId: perEntryRawKey,
    credential,
    mode: profileTypeToAuthMode(credential.type),
  };
}

export async function resolveProviderEntryApiKeyBinding(params: {
  cfg?: OpenClawConfig;
  provider: string;
  store: AuthProfileStore;
  agentDir?: string;
}): Promise<ProviderEntryApiKeyBindingResolution> {
  const reference = resolveProviderEntryApiKeyProfileReference(params);
  if (reference.kind === "none" || reference.kind === "marker") {
    return { kind: "none" };
  }
  if (reference.kind === "literal") {
    return reference;
  }
  if (reference.kind === "profile-incompatible") {
    return reference;
  }
  try {
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store: params.store,
      profileId: reference.profileId,
      agentDir: params.agentDir,
    });
    if (!resolved) {
      return { kind: "profile-unresolved", profileId: reference.profileId };
    }
    const resolvedProfileId = resolved.profileId ?? reference.profileId;
    return {
      kind: "profile-resolved",
      auth: {
        apiKey: resolved.apiKey,
        profileId: resolvedProfileId,
        source: `profile:${resolvedProfileId}`,
        mode: resolved.profileType ? profileTypeToAuthMode(resolved.profileType) : reference.mode,
      },
    };
  } catch (err) {
    return { kind: "profile-unresolved", profileId: reference.profileId, error: err };
  }
}

function resolveConfiguredAwsSdkProfileAuth(params: {
  cfg?: OpenClawConfig;
  provider: string;
  profileId: string;
}): ResolvedProviderAuth | null {
  if (!isConfiguredAwsSdkAuthProfileForProvider(params)) {
    return null;
  }
  return {
    ...resolveAwsSdkAuthInfo(),
    profileId: params.profileId,
    source: `profile:${params.profileId}`,
  };
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "::ffff:7f00:1" ||
      host === "::ffff:127.0.0.1" ||
      host === "docker.orb.internal" ||
      host === "host.docker.internal" ||
      host === "host.orb.internal" ||
      host.endsWith(".local") ||
      isPrivateIpv4Host(host)
    );
  } catch {
    return false;
  }
}

function isPrivateIpv4Host(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function hasExplicitProviderApiKeyConfig(providerConfig: ModelProviderConfig): boolean {
  return (
    normalizeOptionalSecretInput(providerConfig.apiKey) !== undefined ||
    coerceSecretRef(providerConfig.apiKey) !== null
  );
}

function isCustomLocalProviderConfig(providerConfig: ModelProviderConfig): boolean {
  return (
    typeof providerConfig.baseUrl === "string" &&
    providerConfig.baseUrl.trim().length > 0 &&
    typeof providerConfig.api === "string" &&
    providerConfig.api.trim().length > 0 &&
    Array.isArray(providerConfig.models) &&
    providerConfig.models.length > 0
  );
}

function isManagedSecretRefApiKeyMarker(apiKey: string | undefined): boolean {
  return apiKey?.trim() === NON_ENV_SECRETREF_MARKER;
}

export function hasSyntheticLocalProviderAuthConfig(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): boolean {
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
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

  const authOverride = resolveProviderAuthOverride(params.cfg, params.provider);
  if (authOverride && authOverride !== "api-key") {
    return false;
  }
  if (!isCustomLocalProviderConfig(providerConfig)) {
    return false;
  }
  if (hasExplicitProviderApiKeyConfig(providerConfig)) {
    return false;
  }
  return Boolean(providerConfig.baseUrl && isLocalBaseUrl(providerConfig.baseUrl));
}

function listProviderSyntheticAuthRefs(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelApi?: string;
}): string[] {
  const refs = [params.provider];
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
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
  const authOverride = resolveProviderAuthOverride(params.cfg, provider);
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
  if (resolveUsableCustomProviderApiKey({ cfg: params.cfg, provider, env: params.env })) {
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
}): SyntheticProviderAuthResolution {
  const resolveFromConfig = (
    config: OpenClawConfig | undefined,
  ): ResolvedProviderAuth | undefined => {
    const providerConfig = resolveProviderConfig(config, params.provider);
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
  if (!isManagedSecretRefApiKeyMarker(directAuth.apiKey)) {
    return { auth: directAuth };
  }

  const runtimeConfig = getRuntimeConfigSnapshot();
  if (!runtimeConfig || runtimeConfig === params.cfg) {
    return { blockedOnManagedSecretRef: true };
  }

  const runtimeAuth = resolveFromConfig(runtimeConfig);
  const runtimeApiKey = runtimeAuth?.apiKey;
  if (!runtimeAuth || !runtimeApiKey || isNonSecretApiKeyMarker(runtimeApiKey)) {
    return { blockedOnManagedSecretRef: true };
  }
  return {
    auth: runtimeAuth,
  };
}

function resolveSyntheticLocalProviderAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelApi?: string;
}): ResolvedProviderAuth | null {
  const syntheticProviderAuth = resolveProviderSyntheticRuntimeAuth(params);
  if (syntheticProviderAuth.auth) {
    return syntheticProviderAuth.auth;
  }
  if (syntheticProviderAuth.blockedOnManagedSecretRef) {
    return null;
  }

  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
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

function resolveEnvSourceLabel(params: {
  applied: Set<string>;
  envVars: string[];
  label: string;
}): string {
  const shellApplied = params.envVars.some((envVar) => params.applied.has(envVar));
  const prefix = shellApplied ? "shell env: " : "env: ";
  return `${prefix}${params.label}`;
}

function resolveAwsSdkAuthInfo(): { mode: "aws-sdk"; source: string } {
  const applied = new Set(getShellEnvAppliedKeys());
  if (process.env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    return {
      mode: "aws-sdk",
      source: resolveEnvSourceLabel({
        applied,
        envVars: ["AWS_BEARER_TOKEN_BEDROCK"],
        label: "AWS_BEARER_TOKEN_BEDROCK",
      }),
    };
  }
  if (process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()) {
    return {
      mode: "aws-sdk",
      source: resolveEnvSourceLabel({
        applied,
        envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        label: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
      }),
    };
  }
  if (process.env.AWS_PROFILE?.trim()) {
    return {
      mode: "aws-sdk",
      source: resolveEnvSourceLabel({
        applied,
        envVars: ["AWS_PROFILE"],
        label: "AWS_PROFILE",
      }),
    };
  }
  return { mode: "aws-sdk", source: "aws-sdk default chain" };
}

function shouldDeferSyntheticProfileAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  resolvedApiKey: string | undefined;
  modelApi?: string;
}): boolean {
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
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

function resolveScopedAuthProfileStore(params: {
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
  modelApi?: string;
}): Promise<ResolvedProviderAuth> {
  const { provider, cfg, profileId, preferredProfile } = params;
  const agentDir = params.agentDir?.trim() || (cfg ? resolveDefaultAgentDir(cfg) : undefined);
  let scopedStore: AuthProfileStore | undefined = params.store;

  if (profileId) {
    const awsSdkProfileAuth = resolveConfiguredAwsSdkProfileAuth({ cfg, provider, profileId });
    if (awsSdkProfileAuth) {
      return awsSdkProfileAuth;
    }
    const store =
      params.store ??
      resolveScopedAuthProfileStore({
        agentDir,
        cfg,
        provider,
        profileId,
        preferredProfile,
      });
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
      apiKey: resolved.apiKey,
      profileId: resolvedProfileId,
      source: `profile:${resolvedProfileId}`,
      mode: mode ? profileTypeToAuthMode(mode) : "api-key",
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

  if (cfg?.auth?.profiles || cfg?.auth?.order) {
    scopedStore ??= resolveScopedAuthProfileStore({
      agentDir,
      cfg,
      provider,
      preferredProfile,
    });
    const configuredProfileOrder = resolveAuthProfileOrder({
      cfg,
      store: scopedStore,
      provider,
      preferredProfile,
    });
    for (const candidate of configuredProfileOrder) {
      const awsSdkProfileAuth = resolveConfiguredAwsSdkProfileAuth({
        cfg,
        provider,
        profileId: candidate,
      });
      if (awsSdkProfileAuth) {
        return awsSdkProfileAuth;
      }
    }
  }

  const authOverride = resolveProviderAuthOverride(cfg, provider);
  if (authOverride === "aws-sdk") {
    return resolveAwsSdkAuthInfo();
  }
  if (shouldUseImplicitAwsSdkAuth({ cfg, provider, modelApi: params.modelApi })) {
    return resolveAwsSdkAuthInfo();
  }

  if (params.credentialPrecedence === "env-first") {
    const envResolved = resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir);
    if (envResolved) {
      const resolvedMode: ResolvedProviderAuth["mode"] = envResolved.source.includes("OAUTH_TOKEN")
        ? "oauth"
        : "api-key";
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
        apiKey: envResolved.apiKey,
        source: envResolved.source,
        mode: resolvedMode,
      };
    }
  }

  // Resolve stored profile-id references before literal apiKey fallbacks.
  // Matched profile references are terminal so bad bindings cannot silently
  // fall through to a different credential or to the profile id as bearer text.
  scopedStore ??= resolveScopedAuthProfileStore({
    agentDir,
    cfg,
    provider,
    preferredProfile,
  });
  const providerEntryBinding = await resolveProviderEntryApiKeyBinding({
    cfg,
    provider,
    store: scopedStore,
    agentDir,
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

  if (shouldPreferExplicitConfigApiKeyAuth(cfg, provider)) {
    const customKey = resolveUsableCustomProviderApiKey({ cfg, provider });
    if (customKey) {
      return {
        apiKey: customKey.apiKey,
        source: customKey.source,
        mode: "api-key",
      };
    }
  }
  const providerConfig = resolveProviderConfig(cfg, provider);
  const configuredLocalKey = resolveUsableCustomProviderApiKey({ cfg, provider });
  if (configuredLocalKey && isNonSecretApiKeyMarker(configuredLocalKey.apiKey)) {
    return {
      apiKey: configuredLocalKey.apiKey,
      source: configuredLocalKey.source,
      mode: "api-key",
    };
  }
  const localMarkerEnv = resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir);
  if (localMarkerEnv && isNonSecretApiKeyMarker(localMarkerEnv.apiKey)) {
    return {
      apiKey: localMarkerEnv.apiKey,
      source: localMarkerEnv.source,
      mode: "api-key",
    };
  }
  const store =
    scopedStore ??
    resolveScopedAuthProfileStore({
      agentDir,
      cfg,
      provider,
      preferredProfile,
    });
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider,
    preferredProfile,
  });
  let deferredAuthProfileResult: ResolvedProviderAuth | null = null;
  for (const candidate of order) {
    try {
      const awsSdkProfileAuth = resolveConfiguredAwsSdkProfileAuth({
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
          ? profileTypeToAuthMode(mode)
          : "api-key";
        const result: ResolvedProviderAuth = {
          apiKey: resolved.apiKey,
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
      log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
    }
  }

  const envResolved = resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir);
  if (envResolved) {
    const resolvedMode: ResolvedProviderAuth["mode"] = envResolved.source.includes("OAUTH_TOKEN")
      ? "oauth"
      : "api-key";
    if (
      isAuthModeAllowedForModel({
        provider,
        modelApi: params.modelApi,
        mode: resolvedMode,
      })
    ) {
      const result: ResolvedProviderAuth = {
        apiKey: envResolved.apiKey,
        source: envResolved.source,
        mode: resolvedMode,
      };
      return result;
    }
  }

  const customKey = resolveUsableCustomProviderApiKey({ cfg, provider });
  if (customKey) {
    const result = { apiKey: customKey.apiKey, source: customKey.source, mode: "api-key" as const };
    return result;
  }

  if (deferredAuthProfileResult) {
    return deferredAuthProfileResult;
  }

  const syntheticLocalAuth = resolveSyntheticLocalProviderAuth({
    cfg,
    provider,
    modelApi: params.modelApi,
  });
  if (syntheticLocalAuth) {
    return syntheticLocalAuth;
  }

  const hasInlineConfiguredModels =
    Array.isArray(providerConfig?.models) && providerConfig.models.length > 0;
  const owningPluginIds = !hasInlineConfiguredModels
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
      throw new Error(pluginMissingAuthMessage);
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

export type ModelAuthMode = "api-key" | "oauth" | "token" | "mixed" | "aws-sdk" | "unknown";

export { resolveEnvApiKey } from "./model-auth-env.js";
export type { EnvApiKeyResult } from "./model-auth-env.js";

export function resolveModelAuthMode(
  provider?: string,
  cfg?: OpenClawConfig,
  store?: AuthProfileStore,
  options?: { workspaceDir?: string },
): ModelAuthMode | undefined {
  const resolved = provider?.trim();
  if (!resolved) {
    return undefined;
  }

  const authOverride = resolveProviderAuthOverride(cfg, resolved);
  if (authOverride === "aws-sdk") {
    return "aws-sdk";
  }

  const authStore =
    store ??
    resolveScopedAuthProfileStore({
      cfg,
      provider: resolved,
    });
  const profiles = listProfilesForProvider(authStore, resolved);
  if (profiles.length > 0) {
    const modes = new Set(
      profiles
        .map((id) => authStore.profiles[id]?.type)
        .filter((mode): mode is "api_key" | "oauth" | "token" => Boolean(mode)),
    );
    const distinct = ["oauth", "token", "api_key"].filter((k) =>
      modes.has(k as "oauth" | "token" | "api_key"),
    );
    if (distinct.length >= 2) {
      return "mixed";
    }
    if (modes.has("oauth")) {
      return "oauth";
    }
    if (modes.has("token")) {
      return "token";
    }
    if (modes.has("api_key")) {
      return "api-key";
    }
  }

  const envKey = resolveConfigAwareEnvApiKey(cfg, resolved, options?.workspaceDir);
  if (envKey?.apiKey) {
    return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
  }

  if (
    normalizeProviderId(resolved) === "codex" &&
    cliCredentials.readCodexCliCredentialsCached({ ttlMs: 5_000, allowKeychainPrompt: false })
  ) {
    return "oauth";
  }

  if (hasUsableCustomProviderApiKey(cfg, resolved)) {
    return "api-key";
  }

  return "unknown";
}

export async function hasAvailableAuthForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  modelApi?: string;
}): Promise<boolean> {
  const { provider, cfg, preferredProfile } = params;

  const authOverride = resolveProviderAuthOverride(cfg, provider);
  if (authOverride === "aws-sdk") {
    return true;
  }
  const envAuth = resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir);
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
  if (resolveUsableCustomProviderApiKey({ cfg, provider })) {
    return true;
  }
  if (resolveSyntheticLocalProviderAuth({ cfg, provider })) {
    return true;
  }
  const store =
    params.store ??
    resolveScopedAuthProfileStore({
      agentDir: params.agentDir,
      cfg,
      provider,
      preferredProfile,
    });
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider,
    preferredProfile,
  });
  for (const candidate of order) {
    try {
      if (resolveConfiguredAwsSdkProfileAuth({ cfg, provider, profileId: candidate })) {
        return true;
      }
      const resolved = await resolveApiKeyForProfile({
        cfg,
        store,
        profileId: candidate,
        agentDir: params.agentDir,
      });
      const mode = resolved?.profileType ?? store.profiles[candidate]?.type;
      if (
        resolved &&
        isAuthModeAllowedForModel({
          provider,
          modelApi: params.modelApi,
          mode: mode ? profileTypeToAuthMode(mode) : "api-key",
        })
      ) {
        return true;
      }
    } catch (err) {
      log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
    }
  }
  return false;
}

export async function getApiKeyForModel(params: {
  model: Model;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  lockedProfile?: boolean;
  credentialPrecedence?: ProviderCredentialPrecedence;
}): Promise<ResolvedProviderAuth> {
  return resolveApiKeyForProvider({
    provider: params.model.provider,
    cfg: params.cfg,
    profileId: params.profileId,
    preferredProfile: params.preferredProfile,
    store: params.store,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    lockedProfile: params.lockedProfile,
    credentialPrecedence: params.credentialPrecedence,
    modelApi: params.model.api,
  });
}

export function applyLocalNoAuthHeaderOverride<T extends Model>(
  model: T,
  auth: ResolvedProviderAuth | null | undefined,
): T {
  if (auth?.apiKey !== CUSTOM_LOCAL_AUTH_MARKER || model.api !== "openai-completions") {
    return model;
  }

  // OpenAI's SDK always generates Authorization from apiKey. Keep the non-secret
  // placeholder so construction succeeds, then clear the header at request build
  // time for local servers that intentionally do not require auth.
  const headers = {
    ...model.headers,
    Authorization: null,
  } as unknown as Record<string, string>;

  return {
    ...model,
    headers,
  };
}

/**
 * When the provider config sets `authHeader: true`, inject an explicit
 * `Authorization: Bearer <apiKey>` header into the model so downstream SDKs
 * (e.g. `@google/genai`) send credentials via the standard HTTP Authorization
 * header instead of vendor-specific headers like `x-goog-api-key`.
 *
 * This is a no-op when `authHeader` is not `true`, when no API key is
 * available, or when the API key is a synthetic marker (e.g. local-server
 * placeholders) rather than a real credential.
 */
export function applyAuthHeaderOverride<T extends Model>(
  model: T,
  auth: ResolvedProviderAuth | null | undefined,
  cfg: OpenClawConfig | undefined,
): T {
  if (!auth?.apiKey) {
    return model;
  }
  // Reject synthetic marker values that are not real credentials.
  if (isNonSecretApiKeyMarker(auth.apiKey)) {
    return model;
  }
  const providerConfig = resolveProviderConfig(cfg, model.provider);
  if (!providerConfig?.authHeader) {
    return model;
  }

  // Strip any existing authorization header (case-insensitive) before
  // injecting the canonical one so we don't produce a comma-joined value.
  const headers: Record<string, string> = {};
  if (model.headers) {
    for (const [key, value] of Object.entries(model.headers)) {
      if (normalizeOptionalLowercaseString(key) !== "authorization") {
        headers[key] = value;
      }
    }
  }
  headers.Authorization = `Bearer ${auth.apiKey}`;

  return {
    ...model,
    headers,
  };
}
