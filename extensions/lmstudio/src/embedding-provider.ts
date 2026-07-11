// Lmstudio provider module implements model/runtime integration.
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import {
  buildRemoteBaseUrlPolicy,
  createRemoteEmbeddingProvider,
  normalizeEmbeddingModelWithPrefixes,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveMemorySecretInputString } from "openclaw/plugin-sdk/memory-core-host-secret";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { formatErrorMessage, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LMSTUDIO_DEFAULT_EMBEDDING_MODEL, LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";
import {
  normalizeLmstudioConfiguredCatalogEntries,
  resolveLmstudioInferenceBase,
  resolveLmstudioServerBase,
} from "./models.js";
import {
  buildLmstudioAuthHeaders,
  resolveLmstudioConfiguredApiKeyForProvider,
  resolveLmstudioProviderHeaders,
  resolveLmstudioRuntimeApiKey,
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

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) {
    return false;
  }
  return Object.entries(headers).some(
    ([headerName, value]) =>
      headerName.trim().toLowerCase() === "authorization" && value.trim().length > 0,
  );
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
  providerContextTokens: unknown;
  providerContextWindow: unknown;
}): number | undefined {
  const configuredModel = normalizeLmstudioConfiguredCatalogEntries(params.models).find(
    (entry) => normalizeLmstudioModel(entry.id) === params.model,
  );
  if (configuredModel?.contextTokens !== undefined) {
    return configuredModel.contextTokens;
  }
  // Provider contextTokens is the model default, so it caps an explicit model
  // window only when that model did not declare its own effective token cap.
  const providerContextTokens = asPositiveSafeInteger(params.providerContextTokens);
  if (configuredModel?.contextWindow !== undefined && providerContextTokens !== undefined) {
    return Math.min(configuredModel.contextWindow, providerContextTokens);
  }
  return (
    providerContextTokens ??
    configuredModel?.contextWindow ??
    asPositiveSafeInteger(params.providerContextWindow)
  );
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

/** Creates the LM Studio embedding provider client and preloads the target model before return. */
export async function createLmstudioEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: LmstudioEmbeddingClient }> {
  const resolvedProvider = resolveConfiguredLmstudioProvider(options);
  const providerConfig = resolvedProvider?.config;
  const providerBaseUrl = providerConfig?.baseUrl?.trim();
  const isFallbackActivation = options.fallback === "lmstudio" && options.provider !== "lmstudio";
  const remoteBaseUrl = options.remote?.baseUrl?.trim();
  const remoteApiKey = !isFallbackActivation
    ? resolveMemorySecretInputString({
        value: options.remote?.apiKey,
        path: "agents.*.memorySearch.remote.apiKey",
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
  const baseUrl = resolveLmstudioInferenceBase(configuredBaseUrl);
  const model = normalizeLmstudioModel(options.model, resolvedProvider?.providerId);
  const providerHeaders = await resolveLmstudioProviderHeaders({
    config: options.config,
    env: process.env,
    headers: Object.assign(
      {},
      providerConfig?.headers,
      !isFallbackActivation ? options.remote?.headers : {},
    ),
  });
  const apiKey = hasAuthorizationHeader(providerHeaders)
    ? undefined
    : !isFallbackActivation
      ? remoteApiKey?.trim() || (await resolveLmstudioApiKey(options, resolvedProvider?.providerId))
      : await resolveLmstudioApiKey(options, resolvedProvider?.providerId);
  const headerOverrides = Object.assign({}, providerHeaders);
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
    providerContextTokens: providerConfig?.contextTokens,
    providerContextWindow: providerConfig?.contextWindow,
  });
  const localServiceTarget =
    providerConfig?.localService && !baseUrlSource
      ? {
          providerId: resolvedProvider?.providerId ?? LMSTUDIO_PROVIDER_ID,
          baseUrl: resolveLmstudioLocalServiceBaseUrl(providerBaseUrl, baseUrl),
          headers,
        }
      : undefined;
  const acquireLocalService = (options as LocalServiceAwareEmbeddingOptions).acquireLocalService;
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

  await withLocalServiceLease(undefined, async () => {
    try {
      await ensureLmstudioModelLoaded({
        baseUrl,
        apiKey,
        headers: headerOverrides,
        ssrfPolicy,
        modelKey: model,
        requestedContextLength,
        timeoutMs: 120_000,
      });
    } catch (error) {
      log.warn("lmstudio embeddings warmup failed; continuing without preload", {
        baseUrl,
        model,
        error: formatErrorMessage(error),
      });
    }
  });

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
