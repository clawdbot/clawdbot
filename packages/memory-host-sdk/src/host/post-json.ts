import { withRemoteHttpResponse } from "./remote-http.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

export async function postJson<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  body: unknown;
  errorPrefix: string;
  attachStatus?: boolean;
  parse: (payload: unknown) => T | Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    url: params.url,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    init: {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`) as Error & {
          status?: number;
        };
        if (params.attachStatus) {
          err.status = res.status;
        }
        throw err;
      }
      return await params.parse(await res.json());
    },
  });
}
