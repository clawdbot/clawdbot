// Memory Core plugin module implements embeddings behavior.
import {
  getMemoryEmbeddingProvider,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { formatErrorMessage } from "../dreaming-shared.js";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";
import {
  createMissingLocalMemoryEmbeddingProviderError,
  LOCAL_MEMORY_EMBEDDING_PROVIDER_ID,
} from "./local-embedding-provider.js";

export type EmbeddingProvider = MemoryEmbeddingProvider;
export type EmbeddingProviderId = string;
export type EmbeddingProviderRequest = string;
type EmbeddingProviderFallback = string;
export type EmbeddingProviderRuntime = MemoryEmbeddingProviderRuntime;

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider | null;
  requestedProvider: EmbeddingProviderRequest;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  runtime?: EmbeddingProviderRuntime;
};

type CreateEmbeddingProviderOptions = Omit<MemoryEmbeddingProviderCreateOptions, "dimensions"> & {
  provider: EmbeddingProviderRequest;
  fallback: EmbeddingProviderFallback;
  outputDimensionality?: number;
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

const DEFAULT_MEMORY_EMBEDDING_PROVIDER = "openai";

function formatProviderError(adapter: MemoryEmbeddingProviderAdapter, err: unknown): string {
  return adapter.formatSetupError?.(err) ?? formatErrorMessage(err);
}

function getAdapter(
  id: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): MemoryEmbeddingProviderAdapter {
  const adapter = getMemoryEmbeddingProvider(id, config);
  if (adapter) {
    return adapter;
  }
  if (id === LOCAL_MEMORY_EMBEDDING_PROVIDER_ID) {
    throw createMissingLocalMemoryEmbeddingProviderError();
  }
  throw new Error(`Unknown memory embedding provider: ${id}`);
}

function resolveAdapterCreateOptions(
  adapter: MemoryEmbeddingProviderAdapter,
  options: CreateEmbeddingProviderOptions,
): MemoryEmbeddingProviderCreateOptions {
  const { outputDimensionality, ...base } = options;
  const createOptions = {
    ...base,
    fallback: "none",
    model: options.model.trim() || adapter.defaultModel || "",
    ...(typeof outputDimensionality === "number" ? { dimensions: outputDimensionality } : {}),
  };
  return {
    ...createOptions,
    model: adapter.normalizeModel?.(createOptions) ?? createOptions.model,
  };
}

export function resolveEmbeddingProviderFallbackModel(
  providerId: string,
  fallbackSourceModel: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): string {
  const adapter = getMemoryEmbeddingProvider(providerId, config);
  return adapter?.defaultModel ?? fallbackSourceModel;
}

export function resolveEmbeddingProviderFallbackRemote(
  remote: MemoryEmbeddingProviderCreateOptions["remote"],
): MemoryEmbeddingProviderCreateOptions["remote"] {
  if (!remote) {
    return undefined;
  }
  // Endpoint and auth belong to the primary provider; batch settings are safe to reuse.
  const { baseUrl: _baseUrl, apiKey: _apiKey, headers: _headers, ...sharedRemote } = remote;
  return Object.keys(sharedRemote).length > 0 ? sharedRemote : undefined;
}

export function resolveEmbeddingProviderAdapterTransport(
  providerId: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): MemoryEmbeddingProviderAdapter["transport"] {
  try {
    return getAdapter(providerId, config).transport;
  } catch {
    return undefined;
  }
}

export function resolveEmbeddingProviderIndexIdentity(options: CreateEmbeddingProviderOptions) {
  const provider =
    options.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : options.provider;
  try {
    const adapter = getAdapter(provider, options.config);
    const createOptions = resolveAdapterCreateOptions(adapter, { ...options, provider });
    const identity = adapter.resolveIndexIdentity?.(createOptions);
    return {
      provider: { id: adapter.id, model: identity?.model ?? createOptions.model },
      cacheKeyData: identity?.cacheKeyData,
      aliases: identity?.aliases,
    };
  } catch {
    return undefined;
  }
}

async function createWithAdapter(
  adapter: MemoryEmbeddingProviderAdapter,
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const createOptions = resolveAdapterCreateOptions(adapter, options);
  const result = await adapter.create(createOptions);
  return {
    provider: result.provider,
    requestedProvider: options.provider,
    runtime: result.runtime,
  };
}

export async function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const provider =
    options.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : options.provider;
  const primaryAdapter = getAdapter(provider, options.config);
  try {
    return await createWithAdapter(primaryAdapter, {
      ...options,
      provider,
    });
  } catch (primaryErr) {
    const reason = formatProviderError(primaryAdapter, primaryErr);
    if (options.fallback && options.fallback !== "none" && options.fallback !== provider) {
      const fallbackAdapter = getAdapter(options.fallback, options.config);
      try {
        const fallbackResult = await createWithAdapter(fallbackAdapter, {
          ...options,
          provider: options.fallback,
          remote: resolveEmbeddingProviderFallbackRemote(options.remote),
        });
        return {
          ...fallbackResult,
          requestedProvider: provider,
          fallbackFrom: provider,
          fallbackReason: reason,
        };
      } catch (fallbackErr) {
        const fallbackReason = formatProviderError(fallbackAdapter, fallbackErr);
        const wrapped = new Error(
          `${reason}\n\nFallback to ${options.fallback} failed: ${fallbackReason}`,
        ) as Error & { cause?: unknown };
        wrapped.cause = primaryErr;
        throw wrapped;
      }
    }
    const wrapped = new Error(reason) as Error & { cause?: unknown };
    wrapped.cause = primaryErr;
    throw wrapped;
  }
}
