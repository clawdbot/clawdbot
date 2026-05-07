import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import {
  isNonSecretApiKeyMarker,
  resolveEnvSecretRefHeaderValueMarker,
  resolveNonEnvSecretRefApiKeyMarker,
  resolveNonEnvSecretRefHeaderValueMarker,
} from "./model-auth-markers.js";
import { resolveAwsSdkEnvVarName } from "./model-auth-runtime-shared.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

export type ProfileApiKeyResolution = {
  apiKey: string;
  source: "plaintext" | "env-ref" | "non-env-ref";
  discoveryApiKey?: string;
};

export type ProviderApiKeyResolver = (provider: string) => {
  apiKey: string | undefined;
  discoveryApiKey?: string;
};

export type ProviderAuthResolver = (
  provider: string,
  options?: { oauthMarker?: string },
) => {
  apiKey: string | undefined;
  discoveryApiKey?: string;
  mode: "api_key" | "aws-sdk" | "oauth" | "token" | "none";
  source: "env" | "profile" | "none";
  profileId?: string;
};

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function normalizeApiKeyConfig(value: string): string {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export function toDiscoveryApiKey(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || isNonSecretApiKeyMarker(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveEnvApiKeyVarName(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const resolved = resolveEnvApiKey(provider, env);
  if (!resolved) {
    return undefined;
  }
  const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
  return match ? match[1] : undefined;
}

export function resolveAwsSdkApiKeyVarName(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveAwsSdkEnvVarName(env);
}

export function normalizeHeaderValues(params: {
  headers: ProviderConfig["headers"] | undefined;
  secretDefaults: SecretDefaults | undefined;
}): { headers: ProviderConfig["headers"] | undefined; mutated: boolean } {
  const { headers } = params;
  if (!headers) {
    return { headers, mutated: false };
  }
  let mutated = false;
  const nextHeaders: Record<string, NonNullable<ProviderConfig["headers"]>[string]> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const resolvedRef = resolveSecretInputRef({
      value: headerValue,
      defaults: params.secretDefaults,
    }).ref;
    if (!resolvedRef || !resolvedRef.id.trim()) {
      nextHeaders[headerName] = headerValue;
      continue;
    }
    mutated = true;
    nextHeaders[headerName] =
      resolvedRef.source === "env"
        ? resolveEnvSecretRefHeaderValueMarker(resolvedRef.id)
        : resolveNonEnvSecretRefHeaderValueMarker(resolvedRef.source);
  }
  if (!mutated) {
    return { headers, mutated: false };
  }
  return { headers: nextHeaders, mutated: true };
}

export function resolveApiKeyFromCredential(
  cred: AuthProfileStore["profiles"][string] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProfileApiKeyResolution | undefined {
  if (!cred) {
    return undefined;
  }
  if (cred.type === "api_key") {
    const keyRef = coerceSecretRef(cred.keyRef);
    if (keyRef && keyRef.id.trim()) {
      if (keyRef.source === "env") {
        const envVar = keyRef.id.trim();
        return {
          apiKey: envVar,
          source: "env-ref",
          discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        };
      }
      return {
        apiKey: resolveNonEnvSecretRefApiKeyMarker(keyRef.source),
        source: "non-env-ref",
      };
    }
    if (cred.key?.trim()) {
      return {
        apiKey: cred.key,
        source: "plaintext",
        discoveryApiKey: toDiscoveryApiKey(cred.key),
      };
    }
    return undefined;
  }
  if (cred.type === "token") {
    const tokenRef = coerceSecretRef(cred.tokenRef);
    if (tokenRef && tokenRef.id.trim()) {
      if (tokenRef.source === "env") {
        const envVar = tokenRef.id.trim();
        return {
          apiKey: envVar,
          source: "env-ref",
          discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        };
      }
      return {
        apiKey: resolveNonEnvSecretRefApiKeyMarker(tokenRef.source),
        source: "non-env-ref",
      };
    }
    if (cred.token?.trim()) {
      return {
        apiKey: cred.token,
        source: "plaintext",
        discoveryApiKey: toDiscoveryApiKey(cred.token),
      };
    }
  }
  return undefined;
}

export function listAuthProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = resolveProviderIdForAuth(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => resolveProviderIdForAuth(cred.provider) === providerKey)
    .map(([id]) => id);
}

export function resolveApiKeyFromProfiles(params: {
  provider: string;
  store: AuthProfileStore;
  env?: NodeJS.ProcessEnv;
}): ProfileApiKeyResolution | undefined {
  const ids = listAuthProfilesForProvider(params.store, params.provider);
  for (const id of ids) {
    const resolved = resolveApiKeyFromCredential(params.store.profiles[id], params.env);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

export function normalizeConfiguredProviderApiKey(params: {
  providerKey: string;
  provider: ProviderConfig;
  secretDefaults: SecretDefaults | undefined;
  profileApiKey: ProfileApiKeyResolution | undefined;
  secretRefManagedProviders?: Set<string>;
}): ProviderConfig {
  const configuredApiKey = params.provider.apiKey;
  const configuredApiKeyRef = resolveSecretInputRef({
    value: configuredApiKey,
    defaults: params.secretDefaults,
  }).ref;

  if (configuredApiKeyRef && configuredApiKeyRef.id.trim()) {
    const marker =
      configuredApiKeyRef.source === "env"
        ? configuredApiKeyRef.id.trim()
        : resolveNonEnvSecretRefApiKeyMarker(configuredApiKeyRef.source);
    params.secretRefManagedProviders?.add(params.providerKey);
    if (params.provider.apiKey === marker) {
      return params.provider;
    }
    return {
      ...params.provider,
      apiKey: marker,
    };
  }

  if (typeof configuredApiKey !== "string") {
    return params.provider;
  }

  const normalizedConfiguredApiKey = normalizeApiKeyConfig(configuredApiKey);
  if (isNonSecretApiKeyMarker(normalizedConfiguredApiKey)) {
    params.secretRefManagedProviders?.add(params.providerKey);
  }
  if (
    params.profileApiKey &&
    params.profileApiKey.source !== "plaintext" &&
    normalizedConfiguredApiKey === params.profileApiKey.apiKey
  ) {
    params.secretRefManagedProviders?.add(params.providerKey);
  }
  if (normalizedConfiguredApiKey === configuredApiKey) {
    return params.provider;
  }
  return {
    ...params.provider,
    apiKey: normalizedConfiguredApiKey,
  };
}

export function normalizeResolvedEnvApiKey(params: {
  providerKey: string;
  provider: ProviderConfig;
  env: NodeJS.ProcessEnv;
  secretRefManagedProviders?: Set<string>;
}): ProviderConfig {
  const currentApiKey = params.provider.apiKey;
  if (
    typeof currentApiKey !== "string" ||
    !currentApiKey.trim() ||
    ENV_VAR_NAME_RE.test(currentApiKey.trim())
  ) {
    return params.provider;
  }

  const envVarName = resolveEnvApiKeyVarName(params.providerKey, params.env);
  if (!envVarName || params.env[envVarName] !== currentApiKey) {
    return params.provider;
  }
  params.secretRefManagedProviders?.add(params.providerKey);
  return {
    ...params.provider,
    apiKey: envVarName,
  };
}

export function resolveMissingProviderApiKey(params: {
  providerKey: string;
  provider: ProviderConfig;
  env: NodeJS.ProcessEnv;
  profileApiKey: ProfileApiKeyResolution | undefined;
  secretRefManagedProviders?: Set<string>;
  providerApiKeyResolver?: (env: NodeJS.ProcessEnv) => string | undefined;
}): ProviderConfig {
  const hasModels = Array.isArray(params.provider.models) && params.provider.models.length > 0;
  const normalizedApiKey = normalizeOptionalSecretInput(params.provider.apiKey);
  const hasConfiguredApiKey = Boolean(normalizedApiKey || params.provider.apiKey);
  if (!hasModels || hasConfiguredApiKey) {
    return params.provider;
  }

  const authMode = params.provider.auth;
  if (params.providerApiKeyResolver && (!authMode || authMode === "aws-sdk")) {
    const resolvedApiKey = params.providerApiKeyResolver(params.env);
    if (!resolvedApiKey) {
      return params.provider;
    }
    return {
      ...params.provider,
      apiKey: resolvedApiKey,
    };
  }
  if (authMode === "aws-sdk") {
    const awsEnvVar = resolveAwsSdkApiKeyVarName(params.env);
    if (!awsEnvVar) {
      return params.provider;
    }
    return {
      ...params.provider,
      apiKey: awsEnvVar,
    };
  }

  const fromEnv = resolveEnvApiKeyVarName(params.providerKey, params.env);
  const apiKey = fromEnv ?? params.profileApiKey?.apiKey;
  if (!apiKey?.trim()) {
    return params.provider;
  }
  if (params.profileApiKey && params.profileApiKey.source !== "plaintext") {
    params.secretRefManagedProviders?.add(params.providerKey);
  }
  return {
    ...params.provider,
    apiKey,
  };
}
