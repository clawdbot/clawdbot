import { postJson } from "./post-json.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  return await postJson({
    url: params.url,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    body: params.body,
    errorPrefix: params.errorPrefix,
    parse: (payload) => {
      const typedPayload = payload as {
        data?: Array<{ embedding?: number[] }>;
      };
      const data = typedPayload.data ?? [];
      return data.map((entry) => entry.embedding ?? []);
    },
  });
}
