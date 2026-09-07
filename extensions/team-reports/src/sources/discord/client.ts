import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import type { DiscordSourceConfig, SourceRuntime, SourceStatus } from "../../types.js";
import { checkAbort, parseApiBase, wait } from "../http.js";

const retrySchema = z.object({ retry_after: z.number().finite().nonnegative() });
const timeoutMs = 30_000;
export const ABORT_LABEL = "Discord collection aborted.";

export class DiscordHttpError extends Error {
  constructor(readonly status: number) {
    super(`Discord request failed (HTTP ${status}); check bot channel permissions.`);
  }
}

export function createClient(
  config: DiscordSourceConfig,
  runtime: SourceRuntime,
  status: SourceStatus,
) {
  const base = parseApiBase(config.apiBaseUrl, "Discord");

  async function request(url: string) {
    const controller = new AbortController();
    const signal = runtime.signal
      ? AbortSignal.any([runtime.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const init: RequestInit = {
      headers: { Authorization: `Bot ${config.token}`, Accept: "application/json" },
      signal,
      redirect: "error",
    };
    let release: (() => Promise<void>) | undefined;
    try {
      checkAbort(runtime.signal, ABORT_LABEL);
      status.stats.apiCalls = Number(status.stats.apiCalls) + 1;
      let response: Response;
      if (runtime.fetchImpl) {
        response = await runtime.fetchImpl(url, init);
      } else {
        const result = await fetchWithSsrFGuard({
          url,
          init,
          signal,
          timeoutMs,
          requireHttps: true,
          maxRedirects: 0,
          capture: false,
        });
        response = result.response;
        release = result.release;
      }
      const body = await response.text();
      checkAbort(runtime.signal, ABORT_LABEL);
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        data = undefined;
      }
      return { status: response.status, headers: response.headers, data };
    } finally {
      clearTimeout(timer);
      await release?.();
    }
  }

  return {
    async get(path: string, params?: Record<string, string>): Promise<unknown> {
      const url = new URL(path.replace(/^\//, ""), base);
      for (const [key, value] of Object.entries(params ?? {})) {
        url.searchParams.set(key, value);
      }
      let retries = 0;
      while (true) {
        checkAbort(runtime.signal, ABORT_LABEL);
        let result: Awaited<ReturnType<typeof request>>;
        try {
          result = await request(url.toString());
        } catch {
          checkAbort(runtime.signal, ABORT_LABEL);
          if (retries >= 2) {
            throw new Error(
              "Discord request failed after retries; check connectivity and API access.",
            );
          }
          await wait(1000 * 2 ** retries++, runtime.signal, ABORT_LABEL);
          continue;
        }
        if (result.status === 429) {
          const retry = retrySchema.safeParse(result.data);
          const headerDelay = Number(result.headers.get("Retry-After"));
          const seconds = retry.success ? retry.data.retry_after : headerDelay;
          await wait(
            Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000,
            runtime.signal,
            ABORT_LABEL,
          );
          continue;
        }
        if (result.status >= 500 && retries < 2) {
          await wait(1000 * 2 ** retries++, runtime.signal, ABORT_LABEL);
          continue;
        }
        if (result.status < 200 || result.status >= 300) {
          throw new DiscordHttpError(result.status);
        }
        if (result.data === undefined) {
          throw new Error("Discord returned invalid JSON.");
        }
        return result.data;
      }
    },
  };
}
