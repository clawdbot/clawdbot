// Memory Core plugin module implements embeddings behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  acquireMemoryEmbeddingProvider,
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
): { adapter: MemoryEmbeddingProviderAdapter; release(): void; run<T>(operation: () => T): T } {
  const lease = acquireMemoryEmbeddingProvider(id, config);
  if (lease.provider) {
    return { adapter: lease.provider, release: lease.release, run: lease.run };
  }
  lease.release();
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
  const lease = acquireMemoryEmbeddingProvider(providerId, config);
  try {
    return lease.provider?.defaultModel ?? fallbackSourceModel;
  } finally {
    lease.release();
  }
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
    const lease = getAdapter(providerId, config);
    try {
      return lease.adapter.transport;
    } finally {
      lease.release();
    }
  } catch {
    return undefined;
  }
}

export function resolveEmbeddingProviderIndexIdentity(options: CreateEmbeddingProviderOptions) {
  const provider =
    options.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : options.provider;
  try {
    const lease = getAdapter(provider, options.config);
    try {
      const { adapter } = lease;
      const createOptions = lease.run(() =>
        resolveAdapterCreateOptions(adapter, { ...options, provider }),
      );
      const identity = lease.run(() => adapter.resolveIndexIdentity?.(createOptions));
      return {
        provider: { id: adapter.id, model: identity?.model ?? createOptions.model },
        cacheKeyData: identity?.cacheKeyData,
        aliases: identity?.aliases,
      };
    } finally {
      lease.release();
    }
  } catch {
    return undefined;
  }
}

async function createWithAdapter(
  lease: {
    adapter: MemoryEmbeddingProviderAdapter;
    release(): void;
    run<T>(operation: () => T): T;
  },
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const { adapter } = lease;
  const createOptions = lease.run(() => resolveAdapterCreateOptions(adapter, options));
  const result = await lease.run(() => adapter.create(createOptions));
  const { provider, runtime } = result;
  if (!provider) {
    lease.release();
    return { provider, requestedProvider: options.provider, runtime };
  }
  let closing: Promise<void> | undefined;
  const methods: Pick<EmbeddingProvider, "embed" | "embedBatch" | "close"> = {
    embed: (...args) => lease.run(() => provider.embed(...args)),
    embedBatch: (...args) => lease.run(() => provider.embedBatch(...args)),
    close() {
      if (closing) {
        return closing;
      }
      const completion = createDeferred<void>();
      // Publish the attempt before plugin code can reenter; failed cleanup stays retryable.
      closing = completion.promise;
      void (async () => {
        try {
          await lease.run(() => provider.close?.());
          lease.release();
          completion.resolve();
        } catch (error) {
          closing = undefined;
          completion.reject(error);
        }
      })();
      return completion.promise;
    },
  };
  // A separate target can override frozen methods while inheriting discoverable metadata.
  Object.setPrototypeOf(methods, provider);
  return {
    provider: new Proxy(methods, {
      get(target, property) {
        if (Object.hasOwn(target, property)) {
          return Reflect.get(target, property) as unknown;
        }
        const value = Reflect.get(provider, property, provider) as unknown;
        return typeof value === "function" ? value.bind(provider) : value;
      },
      // SAFETY: scoped methods override the original; all other provider fields are forwarded.
    }) as EmbeddingProvider,
    requestedProvider: options.provider,
    runtime: runtime?.batchEmbed
      ? {
          get id() {
            return runtime.id;
          },
          get cacheKeyData() {
            return runtime.cacheKeyData;
          },
          get indexIdentityAliases() {
            return runtime.indexIdentityAliases;
          },
          get inlineQueryTimeoutMs() {
            return runtime.inlineQueryTimeoutMs;
          },
          get inlineBatchTimeoutMs() {
            return runtime.inlineBatchTimeoutMs;
          },
          get sourceWideBatchEmbed() {
            return runtime.sourceWideBatchEmbed;
          },
          batchEmbed: (params) => lease.run(() => runtime.batchEmbed!(params)),
        }
      : runtime,
  };
}

export async function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const provider =
    options.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : options.provider;
  const primaryLease = getAdapter(provider, options.config);
  const primaryAdapter = primaryLease.adapter;
  try {
    return await createWithAdapter(primaryLease, {
      ...options,
      provider,
    });
  } catch (primaryErr) {
    let reason: string;
    try {
      reason = primaryLease.run(() => formatProviderError(primaryAdapter, primaryErr));
    } finally {
      primaryLease.release();
    }
    if (options.fallback && options.fallback !== "none" && options.fallback !== provider) {
      const fallbackLease = getAdapter(options.fallback, options.config);
      const fallbackAdapter = fallbackLease.adapter;
      try {
        const fallbackResult = await createWithAdapter(fallbackLease, {
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
        let fallbackReason: string;
        try {
          fallbackReason = fallbackLease.run(() =>
            formatProviderError(fallbackAdapter, fallbackErr),
          );
        } finally {
          fallbackLease.release();
        }
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
