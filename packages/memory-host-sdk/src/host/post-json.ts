import { withRemoteHttpResponse } from "./remote-http.js";
import { readResponseJsonWithLimit, readResponseTextSnippet } from "./response-snippet.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

export async function postJson<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
  attachStatus?: boolean;
  maxResponseBytes?: number;
  parse: (payload: unknown) => T | Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    url: params.url,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    init: {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await readResponseTextSnippet(res);
        const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`) as Error & {
          status?: number;
        };
        if (params.attachStatus) {
          err.status = res.status;
        }
        throw err;
      }
      const payload = await readResponseJsonWithLimit(res, {
        errorPrefix: params.errorPrefix,
        maxBytes: params.maxResponseBytes,
      });
      return await params.parse(payload);
    },
  });
}
