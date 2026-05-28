import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_EMBED_FALLBACK_MODELS,
  normalizeDeepInfraModelRef,
} from "./media-models.js";

export const DEFAULT_DEEPINFRA_EMBEDDING_MODEL = DEEPINFRA_EMBED_FALLBACK_MODELS[0];

export async function createDeepInfraEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions & { defaultModel?: string },
): Promise<MemoryEmbeddingProviderCreateResult & { client: { model: string } }> {
  const defaultModel = options.defaultModel ?? DEFAULT_DEEPINFRA_EMBEDDING_MODEL;
  const client = await resolveRemoteEmbeddingClient({
    provider: "deepinfra",
    options: {
      ...options,
      model: normalizeDeepInfraModelRef(options.model, defaultModel),
    },
    defaultBaseUrl: DEEPINFRA_BASE_URL,
    normalizeModel: (model) => normalizeDeepInfraModelRef(model, defaultModel),
  });
  const provider = createRemoteEmbeddingProvider({
    id: "deepinfra",
    client,
    errorPrefix: "DeepInfra embeddings API error",
  });
  return { provider, client };
}
