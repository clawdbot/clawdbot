// Voyage provider module implements model/runtime integration.
import {
  createRemoteEmbeddingProvider,
  normalizeEmbeddingModelWithPrefixes,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

export type VoyageEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};

export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const VOYAGE_MAX_INPUT_TOKENS: Record<string, number> = {
  "voyage-3": 32000,
  "voyage-3-lite": 16000,
  "voyage-code-3": 32000,
};

function normalizeVoyageModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
    prefixes: ["voyage/"],
  });
}

export async function createVoyageEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: VoyageEmbeddingClient }> {
  const client = await resolveRemoteEmbeddingClient({
    provider: "voyage",
    options,
    defaultBaseUrl: DEFAULT_VOYAGE_BASE_URL,
    normalizeModel: normalizeVoyageModel,
  });
  const provider = createRemoteEmbeddingProvider({
    id: "voyage",
    client,
    errorPrefix: "voyage embeddings failed",
    buildRequestFields: (kind) => ({ input_type: kind }),
  });
  provider.maxInputTokens = VOYAGE_MAX_INPUT_TOKENS[client.model];
  return { provider, client };
}
