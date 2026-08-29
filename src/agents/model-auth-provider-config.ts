/**
 * Provider-entry configuration and stored-profile binding for model auth.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveMergedModelProviderEntry } from "../config/model-provider-config.js";
import { resolveConfigSecretRef } from "../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  hashRuntimeConfigValue,
} from "../config/runtime-snapshot.js";
import type { ModelProviderAuthMode, ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { canResolveEnvSecretRefInReadOnlyPath } from "../plugin-sdk/secret-ref-readonly.internal.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import {
  isConfiguredAwsSdkAuthProfileForProvider,
  isStoredCredentialCompatibleWithAuthProvider,
} from "./auth-profiles/order.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import {
  isAuthCooldownBypassedForProvider,
  resolveProfileUnusableUntil,
} from "./auth-profiles/usage-state.js";
import { resolveEnvApiKey, type EnvApiKeyResult } from "./model-auth-env.js";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
  SECRETREF_ENV_HEADER_MARKER_PREFIX,
} from "./model-auth-markers.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { isLocalProviderBaseUrl } from "./model-provider-local.js";
import type { ProviderAuthAliasLookupParams } from "./provider-auth-aliases.js";

const MODEL_AUTH_LOCAL_HOST_ALIASES = new Set([
  "docker.orb.internal",
  "host.docker.internal",
  "host.orb.internal",
]);

export function sentinelizeSecretRefProfileApiKey(params: {
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

export function resolveConfigAwareEnvApiKey(
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

export function resolveProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return resolveMergedModelProviderEntry(cfg, provider)?.providerConfig;
}

function resolveProviderConfigSecretInput(cfg: OpenClawConfig | undefined, provider: string) {
  const entry = resolveMergedModelProviderEntry(cfg, provider);
  const providerConfig = entry?.providerConfig;
  return {
    providerConfig,
    ref: entry
      ? resolveConfigSecretRef({
          config: cfg,
          path: `models.providers.${entry.providerKey}.apiKey`,
          value: providerConfig?.apiKey,
          defaults: cfg?.secrets?.defaults,
        })
      : null,
  };
}

/** Reads a literal or env-secret marker for a custom provider entry. */
export function getCustomProviderApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  const { providerConfig, ref } = resolveProviderConfigSecretInput(cfg, provider);
  if (!ref) {
    return normalizeOptionalSecretInput(providerConfig?.apiKey);
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

/** Resolves custom provider API keys that are usable without mutating secret stores. */
export function resolveUsableCustomProviderApiKey(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  env?: NodeJS.ProcessEnv;
  secretSentinels?: boolean;
}): ResolvedCustomProviderApiKey | null {
  const { providerConfig: customProviderConfig, ref: apiKeyRef } = resolveProviderConfigSecretInput(
    params.cfg,
    params.provider,
  );
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

  const customKey = normalizeOptionalSecretInput(customProviderConfig?.apiKey);
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
    isLocalAuthProviderBaseUrl(customProviderConfig.baseUrl)
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
  if (
    !isCustomLocalProviderConfig(providerConfig) ||
    hasExplicitProviderApiKeyConfig(providerConfig)
  ) {
    return false;
  }
  return Boolean(providerConfig.baseUrl && isLocalAuthProviderBaseUrl(providerConfig.baseUrl));
}

export function resolveProviderAuthOverride(
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

export function resolveDirectProviderCredentialMode(params: {
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

export function shouldUseImplicitAwsSdkAuth(params: {
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

export function profileTypeToAuthMode(
  type: AuthProfileCredential["type"],
): ResolvedProviderAuth["mode"] {
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
  | { kind: "marker"; evidence: "environment" | "synthetic" };

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
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  provider: string;
  credential: AuthProfileCredential;
}): boolean {
  if (!isBearerProfileCredential(params.credential)) {
    return false;
  }
  if (
    isStoredCredentialCompatibleWithAuthProvider({
      cfg: params.cfg,
      authAliasLookupParams: params.authAliasLookupParams,
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
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  provider: string;
  store: AuthProfileStore;
}): ProviderEntryApiKeyProfileReference {
  const { providerConfig, ref } = resolveProviderConfigSecretInput(params.cfg, params.provider);
  if (ref) {
    return { kind: "none" };
  }
  const perEntryRawKey = normalizeOptionalSecretInput(providerConfig?.apiKey);
  if (!perEntryRawKey) {
    return { kind: "none" };
  }
  if (isNonSecretApiKeyMarker(perEntryRawKey)) {
    return {
      kind: "marker",
      evidence: isKnownEnvApiKeyMarker(perEntryRawKey) ? "environment" : "synthetic",
    };
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
    !canUseProfileAsProviderEntryApiKey({
      cfg: params.cfg,
      authAliasLookupParams: params.authAliasLookupParams,
      provider: params.provider,
      credential,
    })
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
    const { resolveApiKeyForProfile } = await import("./auth-profiles/oauth.js");
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

export function resolveConfiguredAwsSdkProfileAuth(params: {
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

function isLocalAuthProviderBaseUrl(baseUrl: string): boolean {
  return isLocalProviderBaseUrl(baseUrl, MODEL_AUTH_LOCAL_HOST_ALIASES);
}

function hasExplicitProviderApiKeyConfig(providerConfig: ModelProviderConfig): boolean {
  return (
    normalizeOptionalSecretInput(providerConfig.apiKey) !== undefined ||
    coerceSecretRef(providerConfig.apiKey) !== null
  );
}

function isInlineProviderApiKeySource(source: string): boolean {
  return (
    source === "models.json" ||
    source.endsWith(" (models.json secretref)") ||
    source.endsWith(" (models.json marker)")
  );
}

/** True when a resolved credential came from an inline `models.providers.<id>.apiKey`. */
export function isConfigBackedInlineProviderApiKey(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  source: string;
  store?: AuthProfileStore;
}): boolean {
  if (isInlineProviderApiKeySource(params.source)) {
    return true;
  }
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
  if (!providerConfig || !hasExplicitProviderApiKeyConfig(providerConfig)) {
    return false;
  }
  if (coerceSecretRef(providerConfig.apiKey)) {
    return true;
  }
  const perEntryRawKey = normalizeOptionalSecretInput(providerConfig.apiKey);
  return Boolean(perEntryRawKey && !params.store?.profiles[perEntryRawKey]);
}

// Reads the inline provider API-key cooldown via usage-state primitives instead
// of the auth-profiles usage module, so model-auth keeps working in the many
// tests that partially mock that module. Mirrors the usage-module helper of the
// same intent, using the same provider normalization as the write side so the
// `inline-api-key:<provider>` usage id matches what the failure marker records.
export function resolveInlineProviderApiKeyCooldownUntil(
  store: AuthProfileStore,
  provider: string,
): number | null {
  if (isAuthCooldownBypassedForProvider(provider)) {
    return null;
  }
  const stats = store.usageStats?.[`inline-api-key:${normalizeProviderId(provider)}`];
  return stats ? resolveProfileUnusableUntil(stats) : null;
}

/** Fails closed while an inline provider API key is inside its billing/auth cooldown. */
export function assertInlineProviderApiKeyUsable(params: {
  store: AuthProfileStore;
  provider: string;
}): void {
  const unusableUntil = resolveInlineProviderApiKeyCooldownUntil(params.store, params.provider);
  if (typeof unusableUntil !== "number" || unusableUntil <= Date.now()) {
    return;
  }
  const waitMs = Math.max(0, unusableUntil - Date.now());
  const waitMinutes = Math.max(1, Math.ceil(waitMs / 60_000));
  throw new Error(
    `Inline API key for provider "${params.provider}" is temporarily disabled after a provider auth/billing failure. Retry after about ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}, or switch to a different auth profile/API key.`,
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

export function isManagedSecretRefApiKeyMarker(apiKey: string | undefined): boolean {
  return apiKey?.trim() === NON_ENV_SECRETREF_MARKER;
}

export function hasSecretRefProviderApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
): boolean {
  const { providerConfig, ref } = resolveProviderConfigSecretInput(cfg, provider);
  const apiKey = providerConfig?.apiKey;
  if (ref) {
    return true;
  }
  return (
    typeof apiKey === "string" &&
    (isManagedSecretRefApiKeyMarker(apiKey) ||
      apiKey.trim().startsWith(SECRETREF_ENV_HEADER_MARKER_PREFIX))
  );
}

export function providerConfigMatchesRuntimeSnapshot(params: {
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

export function sentinelizeConfigSecretRefEnvApiKey(params: {
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

export function resolveRuntimeProviderConfigApiKeyAuth(params: {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig | undefined;
  provider: string;
}): ResolvedProviderAuth | undefined {
  const { providerConfig, ref } = resolveProviderConfigSecretInput(params.cfg, params.provider);
  const sourceRef = resolveProviderConfigSecretInput(params.sourceConfig, params.provider).ref;
  // Prepared Ref values are opaque bytes, not authored markers or copy/paste input.
  // Legacy metadata markers without a source Ref still use literal validation.
  const apiKey = sourceRef
    ? providerConfig?.apiKey
    : ref
      ? undefined
      : normalizeOptionalSecretInput(providerConfig?.apiKey);
  if (
    typeof apiKey !== "string" ||
    !apiKey.trim() ||
    (!sourceRef && isNonSecretApiKeyMarker(apiKey))
  ) {
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

function resolveEnvSourceLabel(params: {
  applied: Set<string>;
  envVars: string[];
  label: string;
}): string {
  const shellApplied = params.envVars.some((envVar) => params.applied.has(envVar));
  const prefix = shellApplied ? "shell env: " : "env: ";
  return `${prefix}${params.label}`;
}

export function resolveAwsSdkAuthInfo(): { mode: "aws-sdk"; source: string } {
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
