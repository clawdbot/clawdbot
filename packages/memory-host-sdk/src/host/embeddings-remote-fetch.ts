import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAzureApiVersionRequestTarget } from "./azure-api-version-request.js";
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
  // Azure OpenAI accepts api-version only as a URL query parameter; move a
  // configured api-version header into the URL for recognized Azure hosts.
  const target = resolveAzureApiVersionRequestTarget({
    url: params.url,
    headers: params.headers,
  });
  return await postJson({
    url: target.url,
    headers: target.headers,
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
