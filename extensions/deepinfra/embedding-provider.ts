import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  DEEPINFRA_BASE_URL,
  DEFAULT_DEEPINFRA_EMBEDDING_MODEL,
  normalizeDeepInfraModelRef,
} from "./media-models.js";

export { DEFAULT_DEEPINFRA_EMBEDDING_MODEL };

export async function createDeepInfraEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<MemoryEmbeddingProviderCreateResult & { client: { model: string } }> {
  const client = await resolveRemoteEmbeddingClient({
    provider: "deepinfra",
    options: {
      ...options,
      model: normalizeDeepInfraModelRef(options.model, DEFAULT_DEEPINFRA_EMBEDDING_MODEL),
    },
    defaultBaseUrl: DEEPINFRA_BASE_URL,
    normalizeModel: (model) => normalizeDeepInfraModelRef(model, DEFAULT_DEEPINFRA_EMBEDDING_MODEL),
  });
  const provider = createRemoteEmbeddingProvider({
    id: "deepinfra",
    client,
    errorPrefix: "DeepInfra embeddings API error",
  });
  return { provider, client };
}
