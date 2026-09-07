import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import type { GithubSourceConfig, SourceRuntime, SourceStatus } from "../../types.js";
import { checkAbort, createResponseParser, parseApiBase, wait } from "../http.js";

export const ABORT_LABEL = "GitHub collection aborted";

export class GithubSourceError extends Error {}

export class GithubHttpError extends GithubSourceError {
  constructor(readonly status: number) {
    super(`HTTP ${status}; check token permissions and repository access`);
  }
}

export const parse = createResponseParser(
  () => new GithubSourceError("Invalid API response; check API compatibility"),
);

export function pathWithQuery(path: string, query: Record<string, string>): string {
  return `${path}?${new URLSearchParams({ per_page: "100", ...query })}`;
}

export class GithubClient {
  private readonly base: URL;

  constructor(
    private readonly cfg: GithubSourceConfig,
    private readonly runtime: SourceRuntime,
    readonly status: SourceStatus,
  ) {
    try {
      this.base = parseApiBase(cfg.apiBaseUrl, "GitHub");
    } catch {
      throw new GithubSourceError(
        "GitHub API base URL must be HTTPS without credentials, query, or fragment",
      );
    }
  }

  warn(scope: string, error: unknown): void {
    checkAbort(this.runtime.signal, ABORT_LABEL);
    const detail =
      error instanceof GithubSourceError
        ? error.message
        : "Request failed; check API access and connectivity";
    const message = `${scope}: ${detail}`;
    this.status.warnings.push(
      this.cfg.token ? message.replaceAll(this.cfg.token, "[redacted]") : message,
    );
    this.status.stale = true;
  }

  async attempt(scope: string, action: () => Promise<void>, required = false): Promise<void> {
    checkAbort(this.runtime.signal, ABORT_LABEL);
    try {
      await action();
    } catch (error) {
      this.warn(scope, error);
      if (required) {
        this.status.ok = false;
      }
    }
  }

  private url(path: string): URL {
    const url = new URL(path.replace(/^\/(?!\/)/, ""), this.base);
    if (
      url.origin !== this.base.origin ||
      !url.pathname.startsWith(this.base.pathname) ||
      url.username ||
      url.password
    ) {
      throw new GithubSourceError("Refused API pagination outside the configured base URL");
    }
    return url;
  }

  async get(path: string): Promise<{ data: unknown; next?: string }> {
    const url = this.url(path);
    for (let failures = 0; ;) {
      checkAbort(this.runtime.signal, ABORT_LABEL);
      this.status.stats.apiCalls = Number(this.status.stats.apiCalls) + 1;
      let response: Response;
      let data: unknown;
      let release: (() => Promise<void>) | undefined;
      const controller = new AbortController();
      const signal = this.runtime.signal
        ? AbortSignal.any([this.runtime.signal, controller.signal])
        : controller.signal;
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const init: RequestInit = {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${this.cfg.token}`,
          },
          signal,
          redirect: "error",
        };
        if (this.runtime.fetchImpl) {
          response = await this.runtime.fetchImpl(url, init);
        } else {
          const result = await fetchWithSsrFGuard({
            url: url.href,
            init,
            signal: this.runtime.signal,
            requireHttps: true,
            timeoutMs: 30_000,
            maxRedirects: 0,
            capture: false,
          });
          release = result.release;
          response = result.response;
        }
        // Error payloads can echo credentials; neither parse errors nor API bodies escape this client.
        const body = await response.text();
        checkAbort(this.runtime.signal, ABORT_LABEL);
        if (response.ok) {
          try {
            data = JSON.parse(body);
          } catch {
            throw new GithubSourceError("Invalid JSON API response");
          }
        } else if (response.status === 403) {
          try {
            data = JSON.parse(body);
          } catch {
            data = undefined;
          }
        }
      } catch (error) {
        checkAbort(this.runtime.signal, ABORT_LABEL);
        if (error instanceof GithubSourceError) {
          throw error;
        }
        throw new GithubSourceError(
          controller.signal.aborted
            ? "API request timed out"
            : "Request failed; check API access and connectivity",
        );
      } finally {
        clearTimeout(timeout);
        if (release) {
          await release().catch(() => {
            checkAbort(this.runtime.signal, ABORT_LABEL);
            throw new GithubSourceError("Could not release API response");
          });
        }
      }
      checkAbort(this.runtime.signal, ABORT_LABEL);
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null && Number.isFinite(Number(remaining))) {
        this.status.stats.rateLimitRemaining = Number(remaining);
      }
      const retryAfter = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
      const resetHeader = response.headers.get("x-ratelimit-reset");
      const resetDelay =
        resetHeader === null ? 0 : Math.max(0, Number(resetHeader) * 1000 - Date.now());
      const errorBody = z.object({ message: z.string() }).safeParse(data);
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (remaining === "0" ||
            retryAfter !== undefined ||
            (errorBody.success &&
              /(?:secondary )?rate limit|abuse detection/i.test(errorBody.data.message))));
      if (limited) {
        await wait(
          Math.max(
            1000,
            (retryAfter ?? 0) * 1000,
            Number.isFinite(resetDelay) ? resetDelay : 0,
            retryAfter === undefined && remaining !== "0" ? 60_000 : 0,
          ),
          this.runtime.signal,
          ABORT_LABEL,
        );
        continue;
      }
      if (response.status >= 500 && failures < 3) {
        failures += 1;
        await wait(1000 * 2 ** (failures - 1), this.runtime.signal, ABORT_LABEL);
        continue;
      }
      if (!response.ok) {
        throw new GithubHttpError(response.status);
      }
      const next = response.headers
        .get("link")
        ?.split(/,\s*(?=<)/)
        .find((part) => /;\s*rel="next"(?:;|\s*$)/i.test(part))
        ?.match(/^\s*<([^>]+)>/)?.[1];
      return { data, next: next ? new URL(next, url).href : undefined };
    }
  }

  async *pages<T>(path: string, schema: z.ZodType<T>): AsyncGenerator<T> {
    let next: string | undefined = path;
    const seen = new Set<string>();
    while (next) {
      checkAbort(this.runtime.signal, ABORT_LABEL);
      const canonical = this.url(next).href;
      if (seen.has(canonical)) {
        throw new GithubSourceError("API pagination did not advance");
      }
      seen.add(canonical);
      const page = await this.get(next);
      for (const item of parse(z.array(schema), page.data)) {
        checkAbort(this.runtime.signal, ABORT_LABEL);
        yield item;
      }
      next = page.next;
    }
  }
}
