/**
 * Resolves model-provider credentials from config, env, auth profiles, and
 * provider synthetic auth hooks. This module is the shared auth boundary for
 * runtime dispatch, setup checks, and model metadata reporting.
 */
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { formatCliCommand } from "../cli/command-format.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  hashRuntimeConfigValue,
  selectApplicableRuntimeConfig,
} from "../config/config.js";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
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
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
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
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
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
  isSecretRefHeaderValueMarker,
  NON_ENV_SECRETREF_MARKER,
  SECRETREF_ENV_HEADER_MARKER_PREFIX,
} from "./model-auth-markers.js";
import { ProviderAuthError, type ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { normalizeProviderId } from "./model-selection.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
} from "./provider-request-config.js";

export {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
export { resolveAuthProfileOrderWithMetadata } from "./auth-profiles/order.js";
export {
  formatMissingAuthError,
  isMissingProviderAuthError,
  isProviderAuthError,
  MissingProviderAuthError,
  ProviderAuthError,
  requireApiKey,
  resolveAwsSdkEnvVarName,
} from "./model-auth-runtime-shared.js";
export type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
export type ProviderCredentialPrecedence = "profile-first" | "env-first";

function sentinelizeSecretRefProfileApiKey(params: {
  apiKey: string;
  enabled?: boolean;
  profileId: string;
  provider: string;
  store: AuthProfileStore;
}): string {
  const credential = params.store.profiles[params.profileId];
  const ref =
    credential?.type === "api_key"
      ? coerceSecretRef(credential.keyRef)
      : credential?.type === "token"
        ? coerceSecretRef(credential.tokenRef)
        : null;
  return ref && params.enabled
    ? mintSecretSentinel(params.apiKey, { label: `model-auth:${params.provider}` })
    : params.apiKey;
}

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

function openAICodexTransportRequiresOAuth(params: {
  provider: string;
  modelApi?: string;
}): boolean {
  return (
    normalizeProviderId(params.provider) === OPENAI_PROVIDER_ID &&
    normalizeLowercaseStringOrEmpty(params.modelApi ?? "") === OPENAI_CODEX_RESPONSES_API
  );
}

function isAuthModeAllowedForModel(params: {
  provider: string;
  modelApi?: string;
  mode: ResolvedProviderAuth["mode"];
}): boolean {
  if (openAICodexTransportRequiresOAuth(params)) {
    // Subscription-class credentials are oauth profiles and ChatGPT tokens;
    // api-key must fail closed here or the codex backend 401s at request time.
    return params.mode === "oauth" || params.mode === "token";
  }
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
  if (openAICodexTransportRequiresOAuth(params)) {
    throw new Error(
      `Auth profile "${params.profileId}" uses ${params.mode} auth, but ${params.provider}/${params.modelApi} requires a ChatGPT subscription (OAuth or token) profile.`,
    );
  }
  throw new Error(
    `Auth profile "${params.profileId}" uses ${params.mode} auth, but ${params.provider}/${params.modelApi} requires an OpenAI API key profile.`,
  );
}

function resolveConfigAwareEnvApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
  workspaceDir?: string,
  skipSetupProviderFallback?: boolean,
): EnvApiKeyResult | null {
  return resolveEnvApiKey(provider, process.env, {
    config: cfg,
    workspaceDir,
    ...(skipSetupProviderFallback ? { skipSetupProviderFallback: true } : {}),
  });
}

function resolveProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return resolveMergedModelProviderConfig(cfg, provider);
}

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

/** Resolves custom provider API keys that are usable without mutating secret stores. */
export function resolveUsableCustomProviderApiKey(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  env?: NodeJS.ProcessEnv;
  secretSentinels?: boolean;
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
      apiKey: params.secretSentinels
        ? mintSecretSentinel(envValue, { label: `model-auth:${params.provider}` })
        : envValue,
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

/** True when a custom provider has a literal/env/local key available now. */
export function hasUsableCustomProviderApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  return Boolean(resolveUsableCustomProviderApiKey({ cfg, provider, env }));
}

/** True when explicit provider config should outrank profile/environment auth. */
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

function resolveDirectProviderCredentialMode(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  inferredMode: ResolvedProviderAuth["mode"];
}): ResolvedProviderAuth["mode"] {
  const configuredMode = resolveProviderAuthOverride(params.cfg, params.provider);
  // apiKey is the generic provider credential slot. Explicit subscription
  // strategy classifies its literal, SecretRef, and env material as one route.
  return configuredMode === "oauth" || configuredMode === "token"
    ? configuredMode
    : params.inferredMode;
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

/** True when a bearer auth profile can safely satisfy a provider-entry apiKey reference. */
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

/** Classifies a provider entry apiKey as literal/profile/marker before resolving secrets. */
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

/** Resolves a provider-entry apiKey profile reference into runtime auth when possible. */
export async function resolveProviderEntryApiKeyBinding(params: {
  cfg?: OpenClawConfig;
  provider: string;
  store: AuthProfileStore;
  agentDir?: string;
  secretSentinels?: boolean;
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
        apiKey: sentinelizeSecretRefProfileApiKey({
          apiKey: resolved.apiKey,
          enabled: params.secretSentinels,
          profileId: resolvedProfileId,
          provider: params.provider,
          store: params.store,
        }),
        profileId: resolvedProfileId,
        source: `profile:${resolvedProfileId}`,
        mode: resolved.profileType ? profileTypeToAuthMode(resolved.profileType) : reference.mode,
      },
    };
  } catch (err) {
    if (err instanceof SecretSurfaceUnavailableError) {
      throw err;
    }
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
  return (
    a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
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

function hasSecretRefProviderApiKey(cfg: OpenClawConfig | undefined, provider: string): boolean {
  const apiKey = resolveProviderConfig(cfg, provider)?.apiKey;
  if (coerceSecretRef(apiKey)) {
    return true;
  }
  return (
    typeof apiKey === "string" &&
    (isManagedSecretRefApiKeyMarker(apiKey) ||
      apiKey.trim().startsWith(SECRETREF_ENV_HEADER_MARKER_PREFIX))
  );
}

function providerConfigMatchesRuntimeSnapshot(params: {
  inputConfig: OpenClawConfig | undefined;
  runtimeConfig: OpenClawConfig | null;
  provider: string;
}): boolean {
  const inputProvider = resolveProviderConfig(params.inputConfig, params.provider);
  const runtimeProvider = resolveProviderConfig(params.runtimeConfig ?? undefined, params.provider);
  if (!inputProvider || !runtimeProvider) {
    return false;
  }
  const toComparableConfig = (providerConfig: ModelProviderConfig): OpenClawConfig => ({
    models: { providers: { [params.provider]: providerConfig } },
  });
  return (
    hashRuntimeConfigValue(toComparableConfig(inputProvider)) ===
    hashRuntimeConfigValue(toComparableConfig(runtimeProvider))
  );
}

function sentinelizeConfigSecretRefEnvApiKey(params: {
  apiKey: string;
  source: string;
  cfg: OpenClawConfig | undefined;
  provider: string;
  enabled?: boolean;
}): string {
  if (!params.enabled) {
    return params.apiKey;
  }
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  const sourceConfig = providerConfigMatchesRuntimeSnapshot({
    inputConfig: params.cfg,
    runtimeConfig,
    provider: params.provider,
  })
    ? (runtimeSourceConfig ?? params.cfg)
    : params.cfg;
  const configured = resolveProviderConfig(sourceConfig, params.provider)?.apiKey;
  const ref = coerceSecretRef(configured);
  const envId =
    ref?.source === "env"
      ? ref.id
      : typeof configured === "string" &&
          configured.trim().startsWith(SECRETREF_ENV_HEADER_MARKER_PREFIX)
        ? configured.trim().slice(SECRETREF_ENV_HEADER_MARKER_PREFIX.length)
        : undefined;
  return envId && params.source.includes(envId)
    ? mintSecretSentinel(params.apiKey, { label: `model-auth:${params.provider}` })
    : params.apiKey;
}

function resolveLiteralProviderConfigApiKeyAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): ResolvedProviderAuth | undefined {
  const apiKey = normalizeOptionalSecretInput(
    resolveProviderConfig(params.cfg, params.provider)?.apiKey,
  );
  if (!apiKey || isNonSecretApiKeyMarker(apiKey)) {
    return undefined;
  }
  return {
    apiKey,
    source: `models.providers.${params.provider}`,
    mode: resolveDirectProviderCredentialMode({
      cfg: params.cfg,
      provider: params.provider,
      inferredMode: "api-key",
    }),
  };
}

function resolveManagedSecretRefRuntimeProviderAuth(params: {
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
    providerConfigMatchesRuntimeSnapshot({
      inputConfig: params.cfg,
      runtimeConfig,
      provider: params.provider,
    });
  const sourceConfig = usesRuntimeProvider ? (runtimeSourceConfig ?? undefined) : params.cfg;
  if (!hasSecretRefProviderApiKey(sourceConfig, params.provider)) {
    return undefined;
  }
  if (!runtimeConfig || !usesRuntimeProvider) {
    return undefined;
  }
  const resolved = resolveLiteralProviderConfigApiKeyAuth({
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

function assertRuntimeProviderSecretOwnerAvailable(params: {
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
    providerConfigMatchesRuntimeSnapshot({
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
  if (hasSecretRefProviderApiKey(params.cfg, params.provider)) {
    return { blockedOnManagedSecretRef: true };
  }

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

function resolveSyntheticLocalProviderAuth(params: {
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
    const configuredProfileType = store.profiles[profileId]?.type;
    if (configuredProfileType) {
      assertAuthModeAllowedForModel({
        provider,
        modelApi: params.modelApi,
        profileId,
        mode: profileTypeToAuthMode(configuredProfileType),
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
      apiKey: sentinelizeSecretRefProfileApiKey({
        apiKey: resolved.apiKey,
        enabled: params.secretSentinels,
        profileId: resolvedProfileId,
        provider,
        store,
      }),
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

  if (params.allowAuthProfileFallback !== false && (cfg?.auth?.profiles || cfg?.auth?.order)) {
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
      forModel: params.modelId,
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
    const envResolved = resolveConfigAwareEnvApiKey(
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
        apiKey: sentinelizeConfigSecretRefEnvApiKey({
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

  if (shouldPreferExplicitConfigApiKeyAuth(cfg, provider)) {
    const runtimeCustomKey = resolveManagedSecretRefRuntimeProviderAuth({
      cfg,
      provider,
      secretSentinels: params.secretSentinels,
    });
    if (runtimeCustomKey) {
      return runtimeCustomKey;
    }
    const customKey = resolveUsableCustomProviderApiKey({
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
  const providerConfig = resolveProviderConfig(cfg, provider);
  const configuredLocalKey = resolveUsableCustomProviderApiKey({
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
  const localMarkerEnv = resolveConfigAwareEnvApiKey(
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
  const store =
    scopedStore ??
    resolveScopedAuthProfileStore({
      agentDir,
      cfg,
      provider,
      preferredProfile,
    });
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
      const awsSdkProfileAuth = resolveConfiguredAwsSdkProfileAuth({
        cfg,
        provider,
        profileId: candidate,
      });
      if (awsSdkProfileAuth) {
        return awsSdkProfileAuth;
      }
      const candidateType = store.profiles[candidate]?.type;
      candidateMode = candidateType ? profileTypeToAuthMode(candidateType) : undefined;
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
          ? profileTypeToAuthMode(mode)
          : "api-key";
        const result: ResolvedProviderAuth = {
          apiKey: sentinelizeSecretRefProfileApiKey({
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

  const envResolved = resolveConfigAwareEnvApiKey(
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
    if (
      isAuthModeAllowedForModel({
        provider,
        modelApi: params.modelApi,
        mode: resolvedMode,
      })
    ) {
      const result: ResolvedProviderAuth = {
        apiKey: sentinelizeConfigSecretRefEnvApiKey({
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

  const customKey = resolveUsableCustomProviderApiKey({
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

export type ModelAuthMode = "api-key" | "oauth" | "token" | "mixed" | "aws-sdk" | "unknown";

export { resolveEnvApiKey } from "./model-auth-env.js";
export type { EnvApiKeyResult } from "./model-auth-env.js";

/** Reports the strongest configured auth mode for provider-list UI and diagnostics. */
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

/** Checks provider auth availability, including profile fallback order. */
export async function hasAvailableAuthForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  modelId?: string;
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
    forModel: params.modelId,
  });
  for (const candidate of order) {
    try {
      if (resolveConfiguredAwsSdkProfileAuth({ cfg, provider, profileId: candidate })) {
        return true;
      }
      const candidateType = store.profiles[candidate]?.type;
      if (
        candidateType &&
        !isAuthModeAllowedForModel({
          provider,
          modelApi: params.modelApi,
          mode: profileTypeToAuthMode(candidateType),
        })
      ) {
        continue;
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

/** Resolves request credentials from the provider attached to a model descriptor. */
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
  allowAuthProfileFallback?: boolean;
  skipSetupProviderFallback?: boolean;
  secretSentinels?: boolean;
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
    allowAuthProfileFallback: params.allowAuthProfileFallback,
    skipSetupProviderFallback: params.skipSetupProviderFallback,
    modelId: params.model.id,
    modelApi: params.model.api,
    secretSentinels: params.secretSentinels,
  });
}

/** Clears auth for local OpenAI-compatible servers that explicitly use no auth. */
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

export function applySecretRefHeaderSentinels<T extends Model>(
  model: T,
  cfg: OpenClawConfig | undefined,
): T {
  if (!model.headers) {
    return model;
  }
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  const applicableConfig = selectApplicableRuntimeConfig({
    inputConfig: cfg,
    runtimeConfig,
    runtimeSourceConfig,
  });
  const usesRuntimeProvider =
    applicableConfig === runtimeConfig ||
    providerConfigMatchesRuntimeSnapshot({
      inputConfig: cfg,
      runtimeConfig,
      provider: model.provider,
    });
  if (!runtimeConfig || !runtimeSourceConfig || !usesRuntimeProvider) {
    return model;
  }
  const sourceProvider = resolveProviderConfig(runtimeSourceConfig, model.provider);
  const runtimeProvider = resolveProviderConfig(runtimeConfig, model.provider);
  const replacements = new Map<string, { value: string; replacement: string }>();
  const isManagedSecret = (value: unknown) =>
    coerceSecretRef(value) !== null ||
    (typeof value === "string" && isSecretRefHeaderValueMarker(value));
  const addReplacement = (name: string, value: string, replacement?: string) => {
    replacements.set(name.trim().toLowerCase(), {
      value,
      replacement:
        replacement ?? mintSecretSentinel(value, { label: `model-auth:${model.provider}` }),
    });
  };
  for (const [name, sourceValue] of Object.entries(sourceProvider?.headers ?? {})) {
    if (!isManagedSecret(sourceValue)) {
      continue;
    }
    const value = normalizeOptionalSecretInput(runtimeProvider?.headers?.[name]);
    if (value) {
      addReplacement(name, value);
    }
  }
  for (const [name, sourceValue] of Object.entries(sourceProvider?.request?.headers ?? {})) {
    if (!isManagedSecret(sourceValue)) {
      continue;
    }
    const value = normalizeOptionalSecretInput(runtimeProvider?.request?.headers?.[name]);
    if (value) {
      addReplacement(name, value);
    }
  }
  const sourceAuth = sourceProvider?.request?.auth;
  const runtimeAuth = runtimeProvider?.request?.auth;
  const attachedRequest = getModelProviderRequestTransport(model);
  let protectedRequest = attachedRequest;
  let protectedRequestHeaders: Record<string, string> | undefined;
  for (const [name, sourceValue] of Object.entries(sourceProvider?.request?.headers ?? {})) {
    if (!isManagedSecret(sourceValue)) {
      continue;
    }
    const value = normalizeOptionalSecretInput(runtimeProvider?.request?.headers?.[name]);
    if (!value || attachedRequest?.headers?.[name] !== value) {
      continue;
    }
    protectedRequestHeaders ??= { ...attachedRequest.headers };
    protectedRequestHeaders[name] = mintSecretSentinel(value, {
      label: `model-auth:${model.provider}`,
    });
  }
  if (protectedRequestHeaders && attachedRequest) {
    protectedRequest = { ...attachedRequest, headers: protectedRequestHeaders };
  }
  if (
    sourceAuth?.mode === "authorization-bearer" &&
    runtimeAuth?.mode === "authorization-bearer" &&
    isManagedSecret(sourceAuth.token)
  ) {
    const token = normalizeOptionalSecretInput(runtimeAuth.token)?.trim();
    if (token) {
      if (attachedRequest?.auth?.mode === "authorization-bearer") {
        protectedRequest = {
          ...protectedRequest,
          auth: {
            ...attachedRequest.auth,
            token: mintSecretSentinel(token, { label: `model-auth:${model.provider}` }),
          },
        };
      }
      addReplacement(
        "Authorization",
        `Bearer ${token}`,
        `Bearer ${mintSecretSentinel(token, { label: `model-auth:${model.provider}` })}`,
      );
    }
  } else if (
    sourceAuth?.mode === "header" &&
    runtimeAuth?.mode === "header" &&
    isManagedSecret(sourceAuth.value)
  ) {
    const value = normalizeOptionalSecretInput(runtimeAuth.value)?.trim();
    const headerName = runtimeAuth.headerName.trim();
    const prefix = runtimeAuth.prefix?.trim() ?? "";
    if (headerName && value) {
      if (attachedRequest?.auth?.mode === "header") {
        protectedRequest = {
          ...protectedRequest,
          auth: {
            ...attachedRequest.auth,
            value: mintSecretSentinel(value, { label: `model-auth:${model.provider}` }),
          },
        };
      }
      addReplacement(
        headerName,
        `${prefix}${value}`,
        `${prefix}${mintSecretSentinel(value, { label: `model-auth:${model.provider}` })}`,
      );
    }
  }
  let headers: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(model.headers)) {
    const replacement = replacements.get(name.trim().toLowerCase());
    if (replacement?.value !== value) {
      continue;
    }
    headers ??= { ...model.headers };
    headers[name] = replacement.replacement;
  }
  const protectedModel = headers ? { ...model, headers } : model;
  return protectedRequest && protectedRequest !== attachedRequest
    ? attachModelProviderRequestTransport(protectedModel, protectedRequest)
    : protectedModel;
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
  const sentinelModel = applySecretRefHeaderSentinels(model, cfg);
  if (!auth?.apiKey) {
    return sentinelModel;
  }
  // Reject synthetic marker values that are not real credentials.
  if (isNonSecretApiKeyMarker(auth.apiKey)) {
    return sentinelModel;
  }
  const providerConfig = resolveProviderConfig(cfg, sentinelModel.provider);
  if (!providerConfig?.authHeader) {
    return sentinelModel;
  }

  // Strip any existing authorization header (case-insensitive) before
  // injecting the canonical one so we don't produce a comma-joined value.
  const headers: Record<string, string> = {};
  if (sentinelModel.headers) {
    for (const [key, value] of Object.entries(sentinelModel.headers)) {
      if (normalizeOptionalLowercaseString(key) !== "authorization") {
        headers[key] = value;
      }
    }
  }
  headers.Authorization = `Bearer ${auth.apiKey}`;

  return {
    ...sentinelModel,
    headers,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
