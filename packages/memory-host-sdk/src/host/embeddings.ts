import { expectDefined } from "@openclaw/normalization-core";
import { DEFAULT_LOCAL_MODEL } from "./embedding-defaults.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { createLocalEmbeddingWorkerProvider } from "./embeddings-worker.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";
import {
  attachLocalEmbeddingRuntimeFacts,
  type LocalEmbeddingRuntimeFacts,
} from "./local-embedding-runtime-facts.js";
import {
  importNodeLlamaCpp,
  type Llama,
  type LlamaEmbeddingContext,
  type LlamaModel,
} from "./node-llama.js";
// Memory Host SDK module implements embeddings behavior.
import { toLintErrorObject } from "./retry-utils.js";
import { normalizeOptionalString } from "./string-utils.js";

type DisposableResource = {
  dispose?: () => Promise<void> | void;
};

export type { EmbeddingProvider } from "./embeddings.types.js";

export { DEFAULT_LOCAL_MODEL } from "./embedding-defaults.js";

export type LocalEmbeddingProviderRuntimeOptions = {
  workerScriptPath?: string;
  nodeLlamaCppImportUrl?: string;
};

function copyEmbeddingVector(vector: ArrayLike<number>, maxLength?: number): number[] {
  const length = Math.min(maxLength ?? vector.length, vector.length);
  const values: number[] = [];
  for (let index = 0; index < length; index += 1) {
    values.push(expectDefined(vector[index], `embedding value ${index}`));
  }
  return values;
}

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

async function readLlamaRuntimeFacts(llama: Llama): Promise<LocalEmbeddingRuntimeFacts> {
  const facts: LocalEmbeddingRuntimeFacts = {
    engine: "llama.cpp",
    state: "failed",
    backend: llama.gpu || "cpu",
    buildType: llama.buildType,
    offload: {
      supported: llama.supportsGpuOffloading,
    },
  };
  try {
    facts.deviceNames = await llama.getGpuDeviceNames();
  } catch {
    // Diagnostics must not prevent a model that otherwise works from loading.
  }
  try {
    const memory = await llama.getVramState();
    facts.memory = {
      totalBytes: memory.total,
      usedBytes: memory.used,
      freeBytes: memory.free,
      unifiedBytes: memory.unifiedSize,
      observedAtMs: Date.now(),
    };
  } catch {
    // Some backends cannot report memory state; keep the other runtime facts.
  }
  return facts;
}

function formatRuntimeLoadError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
  runtimeOptions?: LocalEmbeddingProviderRuntimeOptions,
): Promise<EmbeddingProvider> {
  return await createLocalEmbeddingWorkerProvider(options, runtimeOptions);
}

export async function createLocalEmbeddingProviderInProcess(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = normalizeOptionalString(options.local?.modelPath) || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = normalizeOptionalString(options.local?.modelCacheDir);
  const nodeLlamaCppImportUrl = normalizeOptionalString(
    (options.local as EmbeddingProviderOptions["local"] & { nodeLlamaCppImportUrl?: string })
      ?.nodeLlamaCppImportUrl,
  );
  const contextSize: number | "auto" = options.local?.contextSize ?? 4096;

  // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
  const { getLlama, resolveModelFile, LlamaLogLevel } =
    await importNodeLlamaCpp(nodeLlamaCppImportUrl);

  let llama: Llama | null = null;
  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;
  let initPromise: Promise<LlamaEmbeddingContext> | null = null;
  let initAbortController: AbortController | null = null;
  let closePromise: Promise<void> | null = null;
  let runtimeFacts: LocalEmbeddingRuntimeFacts | undefined;
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
          runtimeFacts = {
            ...(await readLlamaRuntimeFacts(llama)),
            context: { requestedSize: contextSize },
          };
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
            ...(typeof contextSize === "number"
              ? {
                  gpuLayers: {
                    fitContext: {
                      contextSize,
                      embeddingContext: true,
                    },
                  },
                }
              : {}),
          });
          embeddingModel = await disposeAndThrowIfClosed(nextModel);
          runtimeFacts = {
            ...runtimeFacts,
            engine: "llama.cpp",
            state: "failed",
            offload: {
              supported: llama.supportsGpuOffloading,
              offloadedLayers: embeddingModel.gpuLayers,
              totalLayers: embeddingModel.fileInsights.totalLayers,
            },
          };
        }
        if (!embeddingContext) {
          const nextContext = await embeddingModel.createEmbeddingContext({
            contextSize,
            createSignal: abortController.signal,
          });
          embeddingContext = await disposeAndThrowIfClosed(nextContext);
          const refreshedRuntimeFacts = await readLlamaRuntimeFacts(llama);
          runtimeFacts = {
            ...runtimeFacts,
            ...refreshedRuntimeFacts,
            engine: "llama.cpp",
            state: "ready",
            offload: {
              supported: llama.supportsGpuOffloading,
              offloadedLayers: embeddingModel.gpuLayers,
              totalLayers: embeddingModel.fileInsights.totalLayers,
            },
            context: { requestedSize: contextSize },
            loadError: undefined,
          };
        }
        return embeddingContext;
      } catch (err) {
        runtimeFacts = {
          ...runtimeFacts,
          engine: "llama.cpp",
          state: "failed",
          context: { requestedSize: contextSize },
          loadError: formatRuntimeLoadError(err),
        };
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

  const outputDimensionality =
    typeof options.outputDimensionality === "number" ? options.outputDimensionality : undefined;
  const normalize = (vector: ArrayLike<number>): number[] =>
    sanitizeAndNormalizeEmbedding(copyEmbeddingVector(vector, outputDimensionality));

  const provider: EmbeddingProvider = {
    id: "local",
    model: modelPath,
    embedQuery: async (text, optionsValue) => {
      throwIfClosed();
      optionsValue?.signal?.throwIfAborted();
      const ctx = await ensureContext();
      throwIfClosed();
      optionsValue?.signal?.throwIfAborted();
      const embedding = await ctx.getEmbeddingFor(text);
      return normalize(embedding.vector);
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
        embeddings.push(normalize(embedding.vector));
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
  attachLocalEmbeddingRuntimeFacts(provider, () => runtimeFacts);
  return provider;
}
