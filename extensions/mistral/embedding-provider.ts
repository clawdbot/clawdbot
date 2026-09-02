// Mistral provider module implements model/runtime integration.
import {
  createRemoteEmbeddingProvider,
  normalizeEmbeddingModelWithPrefixes,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
  type RemoteEmbeddingClient,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { MISTRAL_BASE_URL } from "./model-definitions.js";

export const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";

function normalizeMistralModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
    prefixes: ["mistral/"],
  });
}

export async function createMistralEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: RemoteEmbeddingClient }> {
  const client = await resolveRemoteEmbeddingClient({
    provider: "mistral",
    options,
    defaultBaseUrl: MISTRAL_BASE_URL,
    normalizeModel: normalizeMistralModel,
  });

  return {
    provider: createRemoteEmbeddingProvider({
      id: "mistral",
      client,
      errorPrefix: "mistral embeddings failed",
    }),
    client,
  };
}
