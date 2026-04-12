import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";
import {
  resolveNonEnvSecretRefApiKeyMarker,
  resolveNonEnvSecretRefHeaderValueMarker,
  resolveEnvSecretRefHeaderValueMarker,
} from "./model-auth-markers.js";
import type { ProviderConfig, SecretDefaults } from "./models-config.providers.secrets.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

function normalizeSourceProviderLookup(
  providers: ModelsConfig["providers"] | undefined,
): Record<string, ProviderConfig> {
  if (!providers) {
    return {};
  }
  const out: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || !isRecord(provider)) {
      continue;
    }
    out[normalizedKey] = provider;
  }
  return out;
}

function resolveSourceManagedApiKeyMarker(params: {
  sourceProvider: ProviderConfig | undefined;
  sourceSecretDefaults: SecretDefaults | undefined;
}): string | undefined {
  const sourceApiKeyRef = resolveSecretInputRef({
    value: params.sourceProvider?.apiKey,
    defaults: params.sourceSecretDefaults,
  }).ref;
  if (!sourceApiKeyRef || !sourceApiKeyRef.id.trim()) {
    return undefined;
  }
  return sourceApiKeyRef.source === "env"
    ? sourceApiKeyRef.id.trim()
    : resolveNonEnvSecretRefApiKeyMarker(sourceApiKeyRef.source);
}

function resolveSourceManagedHeaderMarkers(params: {
  sourceProvider: ProviderConfig | undefined;
  sourceSecretDefaults: SecretDefaults | undefined;
}): Record<string, string> {
  const sourceHeaders = isRecord(params.sourceProvider?.headers)
    ? (params.sourceProvider.headers as Record<string, unknown>)
    : undefined;
  if (!sourceHeaders) {
    return {};
  }
  const markers: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(sourceHeaders)) {
    const sourceHeaderRef = resolveSecretInputRef({
      value: headerValue,
      defaults: params.sourceSecretDefaults,
    }).ref;
    if (!sourceHeaderRef || !sourceHeaderRef.id.trim()) {
      continue;
    }
    markers[headerName] =
      sourceHeaderRef.source === "env"
        ? resolveEnvSecretRefHeaderValueMarker(sourceHeaderRef.id)
        : resolveNonEnvSecretRefHeaderValueMarker(sourceHeaderRef.source);
  }
  return markers;
}

export function enforceSourceManagedProviderSecrets(params: {
  providers: ModelsConfig["providers"];
  sourceProviders: ModelsConfig["providers"] | undefined;
  sourceSecretDefaults?: SecretDefaults;
  secretRefManagedProviders?: Set<string>;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const sourceProvidersByKey = normalizeSourceProviderLookup(params.sourceProviders);
  if (Object.keys(sourceProvidersByKey).length === 0) {
    return providers;
  }

  let nextProviders: Record<string, ProviderConfig> | null = null;
  for (const [providerKey, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    const sourceProvider = sourceProvidersByKey[providerKey.trim()];
    if (!sourceProvider) {
      continue;
    }
    let nextProvider = provider;
    let providerMutated = false;

    const sourceApiKeyMarker = resolveSourceManagedApiKeyMarker({
      sourceProvider,
      sourceSecretDefaults: params.sourceSecretDefaults,
    });
    if (sourceApiKeyMarker) {
      params.secretRefManagedProviders?.add(providerKey.trim());
      if (nextProvider.apiKey !== sourceApiKeyMarker) {
        providerMutated = true;
        nextProvider = {
          ...nextProvider,
          apiKey: sourceApiKeyMarker,
        };
      }
    }

    const sourceHeaderMarkers = resolveSourceManagedHeaderMarkers({
      sourceProvider,
      sourceSecretDefaults: params.sourceSecretDefaults,
    });
    if (Object.keys(sourceHeaderMarkers).length > 0) {
      const currentHeaders = isRecord(nextProvider.headers)
        ? (nextProvider.headers as Record<string, unknown>)
        : undefined;
      const nextHeaders = {
        ...(currentHeaders as Record<string, NonNullable<ProviderConfig["headers"]>[string]>),
      };
      let headersMutated = !currentHeaders;
      for (const [headerName, marker] of Object.entries(sourceHeaderMarkers)) {
        if (nextHeaders[headerName] === marker) {
          continue;
        }
        headersMutated = true;
        nextHeaders[headerName] = marker;
      }
      if (headersMutated) {
        providerMutated = true;
        nextProvider = {
          ...nextProvider,
          headers: nextHeaders,
        };
      }
    }

    if (!providerMutated) {
      continue;
    }
    if (!nextProviders) {
      nextProviders = { ...providers };
    }
    nextProviders[providerKey] = nextProvider;
  }

  return nextProviders ?? providers;
}
