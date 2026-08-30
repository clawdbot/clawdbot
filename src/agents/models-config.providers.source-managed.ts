import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
/**
 * Enforces source-managed provider secret ownership rules.
 */
import { resolveConfigSecretRef } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import {
  resolveNonEnvSecretRefApiKeyMarker,
  resolveNonEnvSecretRefHeaderValueMarker,
  resolveEnvSecretRefHeaderValueMarker,
} from "./model-auth-markers.js";
import { normalizeProviderMapKeys } from "./models-config.merge.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

/**
 * Reapplies source-managed secret markers to normalized provider config.
 *
 * This keeps runtime snapshots from materializing secret refs as plain values after config
 * normalization rewrites provider entries.
 */
type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

type SourceProviderEntry = { providerKey: string; providerConfig: ProviderConfig };

export function normalizeSourceProviderLookup(
  providers: ModelsConfig["providers"] | undefined,
): ReadonlyMap<string, SourceProviderEntry> {
  if (!providers) {
    return new Map();
  }
  const validProviders = Object.fromEntries(
    Object.entries(providers)
      .filter(([, provider]) => isRecord(provider))
      .map(([providerKey, providerConfig]): [string, SourceProviderEntry] => [
        providerKey,
        { providerKey, providerConfig },
      ]),
  );
  // Use the merge boundary's collision rule so a case alias cannot displace the
  // canonical SecretRef owner and expose its resolved runtime value to models.json.
  return new Map(Object.entries(normalizeProviderMapKeys(validProviders)));
}

function resolveSourceManagedApiKeyMarker(params: {
  sourceProvider: SourceProviderEntry;
  sourceConfig: OpenClawConfig | undefined;
}): string | undefined {
  const sourceApiKeyRef = resolveConfigSecretRef({
    config: params.sourceConfig,
    path: `models.providers.${params.sourceProvider.providerKey}.apiKey`,
    value: params.sourceProvider.providerConfig.apiKey,
    defaults: params.sourceConfig?.secrets?.defaults,
  });
  if (!sourceApiKeyRef || !sourceApiKeyRef.id.trim()) {
    return undefined;
  }
  return sourceApiKeyRef.source === "env"
    ? sourceApiKeyRef.id.trim()
    : resolveNonEnvSecretRefApiKeyMarker(sourceApiKeyRef.source);
}

function resolveSourceManagedHeaderMarkers(params: {
  sourceProvider: SourceProviderEntry;
  sourceConfig: OpenClawConfig | undefined;
}): Record<string, string> {
  const sourceHeaders = isRecord(params.sourceProvider.providerConfig.headers)
    ? params.sourceProvider.providerConfig.headers
    : undefined;
  if (!sourceHeaders) {
    return {};
  }
  const markers: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(sourceHeaders)) {
    const sourceHeaderRef = resolveConfigSecretRef({
      config: params.sourceConfig,
      path: `models.providers.${params.sourceProvider.providerKey}.headers.${headerName}`,
      value: headerValue,
      defaults: params.sourceConfig?.secrets?.defaults,
    });
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

/** Preserves source-managed apiKey/header markers from the original provider config. */
export function enforceSourceManagedProviderSecrets(params: {
  providers: ModelsConfig["providers"];
  sourceConfigForSecrets: OpenClawConfig | undefined;
  secretRefManagedProviders?: Set<string>;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const sourceProvidersByKey = normalizeSourceProviderLookup(
    params.sourceConfigForSecrets?.models?.providers,
  );
  if (sourceProvidersByKey.size === 0) {
    return providers;
  }

  let nextProviders: Record<string, ProviderConfig> | null = null;
  for (const [providerKey, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    const canonicalProviderKey = normalizeProviderId(providerKey);
    const sourceProvider = sourceProvidersByKey.get(canonicalProviderKey);
    if (!sourceProvider) {
      continue;
    }
    let nextProvider = provider;
    let providerMutated = false;

    const sourceApiKeyMarker = resolveSourceManagedApiKeyMarker({
      sourceProvider,
      sourceConfig: params.sourceConfigForSecrets,
    });
    if (sourceApiKeyMarker) {
      params.secretRefManagedProviders?.add(canonicalProviderKey);
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
      sourceConfig: params.sourceConfigForSecrets,
    });
    if (Object.keys(sourceHeaderMarkers).length > 0) {
      const currentHeaders = isRecord(nextProvider.headers) ? nextProvider.headers : undefined;
      // Merge marker headers over normalized headers so auth metadata remains managed while
      // unrelated provider headers survive normalization.
      const nextHeaders = { ...currentHeaders };
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
