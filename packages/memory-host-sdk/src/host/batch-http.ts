// Memory Host SDK module implements batch http behavior.
import { retryAsync } from "@openclaw/retry";
import { postJson } from "./post-json.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

// JSON POST helper for batch APIs with provider-style transient retry.

/** POST JSON and retry provider 429/5xx failures with bounded backoff. */
export async function postJsonWithRetry<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  retryImpl?: typeof retryAsync;
  body: unknown;
  errorPrefix: string;
}): Promise<T> {
  const retry = params.retryImpl ?? retryAsync;
  return await retry(
    async () => {
      return await postJson<T>({
        url: params.url,
        headers: params.headers,
        ssrfPolicy: params.ssrfPolicy,
        fetchImpl: params.fetchImpl,
        body: params.body,
        errorPrefix: params.errorPrefix,
        attachStatus: true,
        parse: async (payload) => payload as T,
      });
    },
    {
      attempts: 3,
      minDelayMs: 300,
      maxDelayMs: 2000,
      jitter: 0.2,
      shouldRetry: (err) => {
        const status = (err as { status?: number }).status;
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    },
  );
}
