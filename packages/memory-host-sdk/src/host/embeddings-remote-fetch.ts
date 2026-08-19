// Memory Host SDK module implements embeddings remote fetch behavior.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { postJson } from "./post-json.js";

// Fetches and validates OpenAI-compatible embedding responses.

/** Build the common malformed embedding response error. */
function malformedEmbeddingResponse(errorPrefix: string): Error {
  return new Error(`${errorPrefix}: malformed JSON response`);
}

/** Validate and return one finite embedding vector. */
function readEmbeddingVector(value: unknown, errorPrefix: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw malformedEmbeddingResponse(errorPrefix);
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw malformedEmbeddingResponse(errorPrefix);
    }
  }
  return value;
}

/** Resolve expected response count from the request body when input is an array. */
function resolveExpectedEmbeddingCount(body: unknown): number | undefined {
  const input = asOptionalRecord(body)?.input;
  return Array.isArray(input) ? input.length : undefined;
}

/** POST an embedding request and return validated vectors in provider response order. */
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
      const root = asOptionalRecord(payload);
      if (!root || !Array.isArray(root.data)) {
        throw malformedEmbeddingResponse(params.errorPrefix);
      }
      const expectedCount = resolveExpectedEmbeddingCount(params.body);
      if (expectedCount !== undefined && root.data.length !== expectedCount) {
        throw malformedEmbeddingResponse(params.errorPrefix);
      }
      return root.data.map((entry) => {
        const record = asOptionalRecord(entry);
        if (!record) {
          throw malformedEmbeddingResponse(params.errorPrefix);
        }
        return readEmbeddingVector(record.embedding, params.errorPrefix);
      });
    },
  });
}
