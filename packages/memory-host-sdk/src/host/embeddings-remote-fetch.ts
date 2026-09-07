// Memory Host SDK module implements embeddings remote fetch behavior.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readEmbeddingVectors } from "./embedding-vectors.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { postJson } from "./post-json.js";

// Fetches and validates OpenAI-compatible embedding responses.

/** POST an embedding request and return validated vectors in request order. */
export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  return await postJson({
    url: params.url,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    body: params.body,
    errorPrefix: params.errorPrefix,
    parse: (payload) => {
      const input = asOptionalRecord(params.body)?.input;
      return readEmbeddingVectors(
        asOptionalRecord(payload)?.data,
        Array.isArray(input) ? input.length : undefined,
        params.errorPrefix,
      );
    },
  });
}
