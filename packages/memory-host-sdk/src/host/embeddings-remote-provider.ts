import {
  resolveEmbeddingEndpointUrl,
  resolveRemoteEmbeddingBearerClient,
  type RemoteEmbeddingProviderId,
} from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";

// Remote embedding provider factory for OpenAI-compatible embeddings APIs.

/** HTTP client details required by a remote embedding provider. */
export type RemoteEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  model: string;
};

/** Create an EmbeddingProvider backed by a remote embeddings endpoint. */
export function createRemoteEmbeddingProvider(params: {
  id: string;
  client: RemoteEmbeddingClient;
  errorPrefix: string;
  maxInputTokens?: number;
  /** Keep query arrays in one request when the provider has no query/document wire distinction. */
  batchQueryInputs?: boolean;
  /** Additional payload fields; model and input remain owned by the shared request path. */
  buildRequestFields?: (kind: "query" | "document") => Record<string, unknown>;
}): EmbeddingProvider {
  const { client } = params;
  const url = resolveEmbeddingEndpointUrl(client.baseUrl, "embeddings");

  const embedMany = async (
    input: string[],
    signal?: AbortSignal,
    kind: "query" | "document" = "document",
  ): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      fetchImpl: client.fetchImpl,
      signal,
      body: {
        ...params.buildRequestFields?.(kind),
        model: client.model,
        input,
      },
      errorPrefix: params.errorPrefix,
    });
  };

  return {
    id: params.id,
    model: client.model,
    ...(typeof params.maxInputTokens === "number" ? { maxInputTokens: params.maxInputTokens } : {}),
    embed: async (input, options) => {
      const text = typeof input === "string" ? input : input.text;
      const [vec] = await embedMany(
        [text],
        options?.signal,
        options?.inputType === "query" ? "query" : "document",
      );
      return vec ?? [];
    },
    embedBatch: async (inputs, options) => {
      const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
      if (options?.inputType === "query" && params.batchQueryInputs !== true) {
        return await Promise.all(
          texts.map(async (text) => (await embedMany([text], options.signal, "query"))[0] ?? []),
        );
      }
      return await embedMany(
        texts,
        options?.signal,
        options?.inputType === "query" ? "query" : "document",
      );
    },
  };
}

/** Resolve a normalized remote embedding client from provider config and model options. */
export async function resolveRemoteEmbeddingClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
  normalizeModel: (model: string) => string;
}): Promise<RemoteEmbeddingClient> {
  const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
    provider: params.provider,
    options: params.options,
    defaultBaseUrl: params.defaultBaseUrl,
  });
  const model = params.normalizeModel(params.options.model);
  return { baseUrl, headers, ssrfPolicy, model };
}
