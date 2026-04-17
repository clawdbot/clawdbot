import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";
import { importNodeLlamaCpp } from "./node-llama.js";

export type {
  EmbeddingProvider,
  EmbeddingProviderFallback,
  EmbeddingProviderId,
  EmbeddingProviderOptions,
  EmbeddingProviderRequest,
  GeminiTaskType,
} from "./embeddings.types.js";

export const DEFAULT_LOCAL_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

export async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = normalizeOptionalString(options.local?.modelPath) || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = normalizeOptionalString(options.local?.modelCacheDir);

  // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
  const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();

  let llama: Llama | null = null;
  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;
  let initPromise: Promise<LlamaEmbeddingContext> | null = null;

  const ensureContext = async (): Promise<LlamaEmbeddingContext> => {
    if (embeddingContext) {
      return embeddingContext;
    }
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      try {
        if (!llama) {
          llama = await getLlama({ logLevel: LlamaLogLevel.error });
        }
        if (!embeddingModel) {
          const resolved = await resolveModelFile(modelPath, modelCacheDir || undefined);
          embeddingModel = await llama.loadModel({ modelPath: resolved });
        }
        if (!embeddingContext) {
          embeddingContext = await embeddingModel.createEmbeddingContext();
        }
        return embeddingContext;
      } catch (err) {
        initPromise = null;
        throw err;
      }
    })();
    return initPromise;
  };

  return {
    id: "local",
    model: modelPath,
    embedQuery: async (text) => {
      const ctx = await ensureContext();
      const embedding = await ctx.getEmbeddingFor(text);
      return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
    },
    embedBatch: async (texts) => {
      const ctx = await ensureContext();
      const embeddings = await Promise.all(
        texts.map(async (text) => {
          const embedding = await ctx.getEmbeddingFor(text);
          return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
        }),
      );
      return embeddings;
    },
  };
}
