// Lmstudio provider module implements model/runtime integration.
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import {
  buildRemoteBaseUrlPolicy,
  createRemoteEmbeddingProvider,
  embeddingProviderOwnsDestination,
  normalizeEmbeddingModelWithPrefixes,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveMemorySecretInputString } from "openclaw/plugin-sdk/memory-core-host-secret";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { formatErrorMessage, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { LMSTUDIO_DEFAULT_EMBEDDING_MODEL, LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import { ensureLmstudioModelLoaded, fetchLmstudioModels } from "./models.fetch.js";
import {
  normalizeLmstudioConfiguredCatalogEntries,
  resolveLmstudioCanonicalModelKey,
  resolveLmstudioInferenceBase,
  resolveLmstudioServerBase,
} from "./models.js";
import { hasLmstudioAuthorizationHeader } from "./provider-auth.js";
import {
  buildLmstudioAuthHeaders,
  resolveLmstudioConfiguredApiKeyForProvider,
  resolveLmstudioProviderHeaders,
  resolveLmstudioRuntimeApiKey,
  sanitizeLmstudioStringHeaders,
} from "./runtime.js";

const log = createSubsystemLogger("memory/embeddings");

type LmstudioEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};
type MemoryCoreAcquireLocalService = (
  target: {
    providerId: string;
    baseUrl: string;
    headers?: HeadersInit;
  },
  signal?: AbortSignal | null,
) => Promise<{ release: () => void } | undefined>;
type LocalServiceAwareEmbeddingOptions = MemoryEmbeddingProviderCreateOptions & {
  acquireLocalService?: MemoryCoreAcquireLocalService;
};
export const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = LMSTUDIO_DEFAULT_EMBEDDING_MODEL;

/** Normalizes LM Studio embedding model refs and accepts `lmstudio/` prefix. */
function normalizeLmstudioModel(model: string, providerId?: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
    prefixes: [`${providerId?.trim() || LMSTUDIO_PROVIDER_ID}/`, `${LMSTUDIO_PROVIDER_ID}/`],
  });
}

/** Resolves API key (real or synthetic placeholder) from runtime/provider auth config. */
async function resolveLmstudioApiKey(
  options: MemoryEmbeddingProviderCreateOptions,
  providerId?: string,
): Promise<string | undefined> {
  const selectedProviderId = providerId?.trim();
  const selectedApiKey =
    selectedProviderId && selectedProviderId !== LMSTUDIO_PROVIDER_ID
      ? options.config.models?.providers?.[selectedProviderId]?.apiKey
      : undefined;
  if (selectedProviderId && selectedProviderId !== LMSTUDIO_PROVIDER_ID) {
    return selectedApiKey === undefined || selectedApiKey === null
      ? undefined
      : await resolveLmstudioConfiguredApiKeyForProvider({
          providerId: selectedProviderId,
          config: options.config,
          env: process.env,
        });
  }
  try {
    return await resolveLmstudioRuntimeApiKey({
      config: options.config,
      agentDir: options.agentDir,
    });
  } catch (error) {
    // Embeddings can target local LM Studio instances that do not require auth.
    if (/LM Studio API key is required/i.test(formatErrorMessage(error))) {
      return undefined;
    }
    throw error;
  }
}

function resolveEmbeddingPreloadContextLength(params: {
  model: string;
  models: unknown;
}): number | undefined {
  const configuredModel = normalizeLmstudioConfiguredCatalogEntries(params.models).find(
    (entry) => normalizeLmstudioModel(entry.id) === params.model,
  );
  if (configuredModel?.contextTokens !== undefined) {
    return configuredModel.contextTokens;
  }
  return configuredModel?.contextWindow;
}

function resolveConfiguredLmstudioProvider(options: MemoryEmbeddingProviderCreateOptions) {
  const providers = options.config.models?.providers;
  if (!providers) {
    return undefined;
  }
  const providerId = options.provider?.trim() || LMSTUDIO_PROVIDER_ID;
  const direct = providers[providerId];
  if (direct) {
    return { providerId, config: direct };
  }
  const normalized = normalizeProviderId(providerId);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return { providerId: candidateId, config: candidate };
    }
  }
  const fallback = providers[LMSTUDIO_PROVIDER_ID];
  return fallback ? { providerId: LMSTUDIO_PROVIDER_ID, config: fallback } : undefined;
}

function resolveLmstudioLocalServiceBaseUrl(
  configuredBaseUrl: string | undefined,
  inferenceBaseUrl: string,
): string {
  const configured = configuredBaseUrl?.trim();
  if (!configured) {
    return inferenceBaseUrl;
  }
  const configuredPath = configured.replace(/[?#].*$/u, "").replace(/\/+$/u, "");
  const serverBaseUrl = resolveLmstudioServerBase(configured);
  return /\/api\/v1$/iu.test(configuredPath) ? `${serverBaseUrl}/api/v1` : `${serverBaseUrl}/v1`;
}

function resolveLmstudioEmbeddingBaseUrl(configuredBaseUrl?: string): string {
  const query = configuredBaseUrl?.match(/\?[^#]*/u)?.[0] ?? "";
  return `${resolveLmstudioInferenceBase(configuredBaseUrl)}${query}`;
}

async function resolveLmstudioEmbeddingModelKey(params: {
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
}): Promise<string> {
  const discovered = await fetchLmstudioModels({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
  });
  if (!discovered.reachable || (discovered.status !== undefined && discovered.status >= 400)) {
    return params.model;
  }
  return resolveLmstudioCanonicalModelKey({
    modelKey: params.model,
    models: discovered.models,
  });
}

/** Creates the LM Studio embedding provider client and preloads the target model before return. */
export async function createLmstudioEmbeddingProvider(
  options: LocalServiceAwareEmbeddingOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: LmstudioEmbeddingClient }> {
  const resolvedProvider = resolveConfiguredLmstudioProvider(options);
  const providerConfig = resolvedProvider?.config;
  const providerBaseUrl = providerConfig?.baseUrl?.trim();
  const isFallbackActivation = options.fallback === "lmstudio" && options.provider !== "lmstudio";
  const remoteBaseUrl = options.remote?.baseUrl?.trim();
  const remoteApiKey = !isFallbackActivation
    ? resolveMemorySecretInputString({
        value: options.remote?.apiKey,
        path: "memory.search.remote.apiKey",
      })
    : undefined;
  // memorySearch.remote is shared across primary + fallback providers.
  // Ignore it during fallback activation to avoid inheriting another provider's
  // endpoint/headers/credentials when LM Studio activates as a fallback.
  const baseUrlSource = !isFallbackActivation ? remoteBaseUrl : undefined;
  const configuredBaseUrl =
    baseUrlSource && baseUrlSource.length > 0
      ? baseUrlSource
      : providerBaseUrl && providerBaseUrl.length > 0
        ? providerBaseUrl
        : undefined;
  const baseUrl = resolveLmstudioEmbeddingBaseUrl(configuredBaseUrl);
  const providerOwnedBaseUrl = resolveLmstudioEmbeddingBaseUrl(providerBaseUrl);
  const providerOwnsDestination =
    !baseUrlSource ||
    embeddingProviderOwnsDestination({ baseUrl, providerBaseUrl: providerOwnedBaseUrl });
  const model = normalizeLmstudioModel(options.model, resolvedProvider?.providerId);
  const providerHeaders = providerOwnsDestination
    ? await resolveLmstudioProviderHeaders({
        config: options.config,
        env: process.env,
        headers: providerConfig?.headers,
      })
    : undefined;
  // Memory remote headers are resolved snapshot values, never fresh SecretRefs.
  const headerOverrides = Object.assign(
    {},
    providerHeaders,
    !isFallbackActivation ? sanitizeLmstudioStringHeaders(options.remote?.headers) : undefined,
  );
  const apiKey = hasLmstudioAuthorizationHeader(headerOverrides)
    ? undefined
    : !isFallbackActivation
      ? remoteApiKey?.trim() ||
        (providerOwnsDestination
          ? await resolveLmstudioApiKey(options, resolvedProvider?.providerId)
          : undefined)
      : await resolveLmstudioApiKey(options, resolvedProvider?.providerId);
  const headers =
    buildLmstudioAuthHeaders({
      apiKey,
      json: true,
      headers: headerOverrides,
    }) ?? {};
  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
  const client: LmstudioEmbeddingClient = {
    baseUrl,
    model,
    headers,
    ssrfPolicy,
  };
  const requestedContextLength = resolveEmbeddingPreloadContextLength({
    model,
    models: providerConfig?.models,
  });
  const localServiceTarget =
    providerConfig?.localService && !baseUrlSource
      ? {
          providerId: resolvedProvider?.providerId ?? LMSTUDIO_PROVIDER_ID,
          baseUrl: resolveLmstudioLocalServiceBaseUrl(providerBaseUrl, baseUrl),
          headers,
        }
      : undefined;
  const acquireLocalService = options.acquireLocalService;
  const withLocalServiceLease = async <T>(
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> => {
    const lease =
      localServiceTarget && acquireLocalService
        ? await acquireLocalService(localServiceTarget, signal)
        : undefined;
    try {
      return await action();
    } finally {
      lease?.release();
    }
  };

  // The provider-owned JIT opt-out applies to embeddings as well as chat.
  if (providerConfig?.params?.preload !== false) {
    await withLocalServiceLease(undefined, async () => {
      try {
        client.model = await ensureLmstudioModelLoaded({
          baseUrl,
          apiKey,
          headers: headerOverrides,
          ssrfPolicy,
          modelKey: model,
          requestedContextLength,
          timeoutMs: 120_000,
        });
      } catch (error) {
        // Discovery still identifies the wire model when the subsequent load fails.
        if (error instanceof Error && "resolvedModelKey" in error) {
          const resolvedModelKey = error.resolvedModelKey;
          if (typeof resolvedModelKey === "string" && resolvedModelKey.trim()) {
            client.model = resolvedModelKey.trim();
          }
        }
        log.warn("lmstudio embeddings warmup failed; continuing without preload", {
          baseUrl,
          model,
          error: formatErrorMessage(error),
        });
      }
    });
  } else if (model.includes("@")) {
    // Variant aliases are not accepted by LM Studio's inference routes. Resolve
    // only the stable wire/cache identity here; JIT still owns the actual load.
    try {
      await withLocalServiceLease(undefined, async () => {
        client.model = await resolveLmstudioEmbeddingModelKey({
          baseUrl,
          apiKey,
          headers: headerOverrides,
          ssrfPolicy,
          model,
        });
      });
    } catch (error) {
      log.debug("lmstudio embedding variant discovery failed; using requested model", {
        baseUrl,
        model,
        error: formatErrorMessage(error),
      });
    }
  }

  const remoteProvider = createRemoteEmbeddingProvider({
    id: LMSTUDIO_PROVIDER_ID,
    client,
    errorPrefix: "lmstudio embeddings failed",
  });
  const provider: MemoryEmbeddingProvider = {
    ...remoteProvider,
    embedQuery: async (text, callOptions) =>
      await withLocalServiceLease(callOptions?.signal, async () => {
        return await remoteProvider.embedQuery(text, callOptions);
      }),
    embedBatch: async (texts, callOptions) =>
      await withLocalServiceLease(callOptions?.signal, async () => {
        return await remoteProvider.embedBatch(texts, callOptions);
      }),
    ...(remoteProvider.embedBatchInputs
      ? {
          embedBatchInputs: async (
            inputs: Parameters<NonNullable<MemoryEmbeddingProvider["embedBatchInputs"]>>[0],
            callOptions?: Parameters<NonNullable<MemoryEmbeddingProvider["embedBatchInputs"]>>[1],
          ) =>
            await withLocalServiceLease(callOptions?.signal, async () => {
              return await remoteProvider.embedBatchInputs!(inputs, callOptions);
            }),
        }
      : {}),
  };
  return {
    provider,
    client,
  };
}
