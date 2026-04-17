import {
  createRemoteEmbeddingProvider,
  normalizeEmbeddingModelWithPrefixes,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

export type MistralEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};

export const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

export function normalizeMistralModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
    prefixes: ["mistral/"],
  });
}

export async function createMistralEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: MistralEmbeddingClient }> {
  const client = await resolveMistralEmbeddingClient(options);

  return {
    provider: createRemoteEmbeddingProvider({
      id: "mistral",
      client,
      errorPrefix: "mistral embeddings failed",
    }),
    client,
  };
}

export async function resolveMistralEmbeddingClient(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<MistralEmbeddingClient> {
  return await resolveRemoteEmbeddingClient({
    provider: "mistral",
    options,
    defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
    normalizeModel: normalizeMistralModel,
  });
}
