import {
  fetchRemoteEmbeddingVectors,
  normalizeEmbeddingModelWithPrefixes,
  resolveRemoteEmbeddingBearerClient,
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

export function normalizeVoyageModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
    prefixes: ["voyage/"],
  });
}

export async function createVoyageEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: VoyageEmbeddingClient }> {
  const client = await resolveVoyageEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[], input_type?: "query" | "document"): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const body: { model: string; input: string[]; input_type?: "query" | "document" } = {
      model: client.model,
      input,
    };
    if (input_type) {
      body.input_type = input_type;
    }

    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      body,
      errorPrefix: "voyage embeddings failed",
    });
  };

  return {
    provider: {
      id: "voyage",
      model: client.model,
      maxInputTokens: VOYAGE_MAX_INPUT_TOKENS[client.model],
      embedQuery: async (text) => {
        const [vec] = await embed([text], "query");
        return vec ?? [];
      },
      embedBatch: async (texts) => embed(texts, "document"),
    },
    client,
  };
}

export async function resolveVoyageEmbeddingClient(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<VoyageEmbeddingClient> {
  const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
    provider: "voyage",
    options,
    defaultBaseUrl: DEFAULT_VOYAGE_BASE_URL,
  });
  const model = normalizeVoyageModel(options.model);
  return { baseUrl, headers, ssrfPolicy, model };
}
