/**
 * Model-level auth diagnostics and request-header preparation.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import {
  type AuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import * as cliCredentials from "./cli-credentials.js";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  isNonSecretApiKeyMarker,
  isSecretRefHeaderValueMarker,
} from "./model-auth-markers.js";
import { isAuthModeAllowedForModel } from "./model-auth-openai.js";
import * as authConfig from "./model-auth-provider-config.js";
import {
  resolveApiKeyForProvider,
  resolveScopedAuthProfileStore,
  type ProviderCredentialPrecedence,
} from "./model-auth-provider.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { resolveSyntheticLocalProviderAuth } from "./model-auth-runtime.js";
import { normalizeProviderId } from "./model-selection.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
} from "./provider-request-config.js";

const log = createSubsystemLogger("model-auth");

export type ModelAuthMode = "api-key" | "oauth" | "token" | "mixed" | "aws-sdk" | "unknown";

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

  const authOverride = authConfig.resolveProviderAuthOverride(cfg, resolved);
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

  const envKey = authConfig.resolveConfigAwareEnvApiKey(cfg, resolved, options?.workspaceDir);
  if (envKey?.apiKey) {
    return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
  }

  if (
    normalizeProviderId(resolved) === "codex" &&
    cliCredentials.readCodexCliCredentialsCached({ ttlMs: 5_000, allowKeychainPrompt: false })
  ) {
    return "oauth";
  }

  if (authConfig.hasUsableCustomProviderApiKey(cfg, resolved)) {
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

  const authOverride = authConfig.resolveProviderAuthOverride(cfg, provider);
  if (authOverride === "aws-sdk") {
    return true;
  }
  const envAuth = authConfig.resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir);
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
  if (authConfig.resolveUsableCustomProviderApiKey({ cfg, provider })) {
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
      if (
        authConfig.resolveConfiguredAwsSdkProfileAuth({
          cfg,
          provider,
          profileId: candidate,
        })
      ) {
        return true;
      }
      const candidateType = store.profiles[candidate]?.type;
      if (
        candidateType &&
        !isAuthModeAllowedForModel({
          provider,
          modelApi: params.modelApi,
          mode: authConfig.profileTypeToAuthMode(candidateType),
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
          mode: mode ? authConfig.profileTypeToAuthMode(mode) : "api-key",
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
    authConfig.providerConfigMatchesRuntimeSnapshot({
      inputConfig: cfg,
      runtimeConfig,
      provider: model.provider,
    });
  if (!runtimeConfig || !runtimeSourceConfig || !usesRuntimeProvider) {
    return model;
  }
  const sourceProvider = authConfig.resolveProviderConfig(runtimeSourceConfig, model.provider);
  const runtimeProvider = authConfig.resolveProviderConfig(runtimeConfig, model.provider);
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
  const providerConfig = authConfig.resolveProviderConfig(cfg, sentinelModel.provider);
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
