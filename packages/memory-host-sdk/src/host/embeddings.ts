// Memory Host SDK module implements embeddings behavior.
import { DEFAULT_LOCAL_MODEL } from "./embedding-defaults.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { createLocalEmbeddingWorkerProvider } from "./embeddings-worker.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";
import {
  importNodeLlamaCpp,
  type Llama,
  type LlamaEmbeddingContext,
  type LlamaModel,
} from "./node-llama.js";
import { normalizeOptionalString } from "./string-utils.js";

type DisposableResource = {
  dispose?: () => Promise<void> | void;
};

export type {
  EmbeddingProvider,
  EmbeddingProviderFallback,
  EmbeddingProviderId,
  EmbeddingProviderOptions,
  EmbeddingProviderRequest,
  GeminiTaskType,
} from "./embeddings.types.js";

export { DEFAULT_LOCAL_MODEL } from "./embedding-defaults.js";

export type LocalEmbeddingProviderRuntimeOptions = {
  workerScriptPath?: string;
};

async function disposeResources(
  resources: Array<DisposableResource | null | undefined>,
): Promise<void> {
  let firstError: unknown;
  for (const resource of resources) {
    try {
      await resource?.dispose?.();
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError) {
    throw toLintErrorObject(firstError, "Non-Error thrown");
  }
}

export async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  return await createLocalEmbeddingWorkerProvider(options);
}

export async function createLocalEmbeddingProviderInProcess(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = normalizeOptionalString(options.local?.modelPath) || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = normalizeOptionalString(options.local?.modelCacheDir);
  const contextSize: number | "auto" = options.local?.contextSize ?? 4096;

  // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
  const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();

  let llama: Llama | null = null;
  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;
  let initPromise: Promise<LlamaEmbeddingContext> | null = null;
  let initAbortController: AbortController | null = null;
  let closePromise: Promise<void> | null = null;
  let closed = false;

  const throwIfClosed = () => {
    if (closed) {
      throw new Error("Local embedding provider has been closed");
    }
  };
  const disposeAndThrowIfClosed = async <T extends DisposableResource>(resource: T): Promise<T> => {
    if (!closed) {
      return resource;
    }
    await disposeResources([resource]);
    throwIfClosed();
    return resource;
  };

  const ensureContext = async (): Promise<LlamaEmbeddingContext> => {
    throwIfClosed();
    if (embeddingContext) {
      return embeddingContext;
    }
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      const abortController = new AbortController();
      initAbortController = abortController;
      try {
        if (!llama) {
          const nextLlama = await getLlama({
            logLevel: LlamaLogLevel.error,
          });
          llama = await disposeAndThrowIfClosed(nextLlama);
        }
        if (!embeddingModel) {
          const resolved = await resolveModelFile(modelPath, {
            ...(modelCacheDir ? { directory: modelCacheDir } : {}),
            signal: abortController.signal,
          });
          throwIfClosed();
          const nextModel = await llama.loadModel({
            modelPath: resolved,
            loadSignal: abortController.signal,
          });
          embeddingModel = await disposeAndThrowIfClosed(nextModel);
        }
        if (!embeddingContext) {
          const nextContext = await embeddingModel.createEmbeddingContext({
            contextSize,
            createSignal: abortController.signal,
          });
          embeddingContext = await disposeAndThrowIfClosed(nextContext);
        }
        return embeddingContext;
      } catch (err) {
        initPromise = null;
        throw err;
      } finally {
        if (initAbortController === abortController) {
          initAbortController = null;
        }
      }
    })();
    return initPromise;
  };

  return {
    id: "local",
    model: modelPath,
    embedQuery: async (text, optionsValue) => {
      throwIfClosed();
      optionsValue?.signal?.throwIfAborted();
      const ctx = await ensureContext();
      throwIfClosed();
      optionsValue?.signal?.throwIfAborted();
      const embedding = await ctx.getEmbeddingFor(text);
      return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
    },
    embedBatch: async (texts, optionsLocal) => {
      throwIfClosed();
      optionsLocal?.signal?.throwIfAborted();
      const ctx = await ensureContext();
      throwIfClosed();
      optionsLocal?.signal?.throwIfAborted();
      const embeddings: number[][] = [];
      for (const text of texts) {
        throwIfClosed();
        optionsLocal?.signal?.throwIfAborted();
        const embedding = await ctx.getEmbeddingFor(text);
        embeddings.push(sanitizeAndNormalizeEmbedding(Array.from(embedding.vector)));
      }
      return embeddings;
    },
    close: async () => {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      initAbortController?.abort();
      initAbortController = null;
      closePromise = (async () => {
        const context = embeddingContext;
        const model = embeddingModel;
        const runtime = llama;
        embeddingContext = null;
        embeddingModel = null;
        llama = null;
        initPromise = null;
        await disposeResources([context, model, runtime]);
      })();
      return closePromise;
    },
  };
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
