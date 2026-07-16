// Discord API module exposes the plugin public contract.
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  parseRetryAfterHeaderSeconds,
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
} from "openclaw/plugin-sdk/retry-runtime";
import { isDiscordHtmlResponseBody, summarizeDiscordResponseBody } from "./error-body.js";
import { parseDiscordRetryAfterBodySeconds } from "./retry-after.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_API_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 5 * 60_000,
  jitter: 0.1,
};
const DISCORD_API_429_FALLBACK_RETRY_AFTER_SECONDS = 60;
const DISCORD_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const DISCORD_API_RESPONSE_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
export const DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS = 10_000;

type DiscordApiErrorPayload = {
  message?: string;
  retry_after?: number;
  code?: number;
  global?: boolean;
};

function parseDiscordApiErrorPayload(text: string): DiscordApiErrorPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const payload = JSON.parse(trimmed);
    if (payload && typeof payload === "object") {
      return payload as DiscordApiErrorPayload;
    }
  } catch {
    return null;
  }
  return null;
}

function parseRetryAfterSeconds(text: string, response: Response): number | undefined {
  const payload = parseDiscordApiErrorPayload(text);
  const retryAfter = parseDiscordRetryAfterBodySeconds(payload?.retry_after);
  if (retryAfter !== undefined) {
    return retryAfter;
  }
  const header = response.headers.get("Retry-After");
  if (!header) {
    return undefined;
  }
  return parseRetryAfterHeaderSeconds(header);
}

function formatRetryAfterSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded}s`;
}

function formatDiscordApiErrorText(text: string, response: Response): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const payload = parseDiscordApiErrorPayload(trimmed);
  if (!payload) {
    const looksJson = trimmed.startsWith("{") && trimmed.endsWith("}");
    if (looksJson) {
      return "unknown error";
    }
    const summary = summarizeDiscordResponseBody(trimmed);
    if (isDiscordHtmlResponseBody(trimmed, response.headers.get("content-type"))) {
      if (!summary) {
        return response.status === 429 ? "rate limited by Discord upstream" : undefined;
      }
      return response.status === 429 ? `rate limited by Discord upstream: ${summary}` : summary;
    }
    return summary;
  }
  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "unknown error";
  const retryAfter = formatRetryAfterSeconds(
    parseDiscordRetryAfterBodySeconds(payload.retry_after),
  );
  return retryAfter ? `${message} (retry after ${retryAfter})` : message;
}

export class DiscordApiError extends Error {
  status: number;
  retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function getDiscordApiRetryAfterMs(
  err: unknown,
  retryConfig: Required<RetryConfig>,
): number | undefined {
  if (!(err instanceof DiscordApiError) || typeof err.retryAfter !== "number") {
    return undefined;
  }
  return Math.min(Math.max(0, err.retryAfter * 1000), retryConfig.maxDelayMs);
}

type DiscordFetchOptions = {
  retry?: RetryConfig;
  label?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type DiscordApiRequestOptions = DiscordFetchOptions & {
  body?: unknown;
  fetcher?: typeof fetch;
  headers?: Record<string, string>;
  method?: string;
};

function normalizeDiscordRequestBody(body: unknown, headers: Headers): BodyInit | null | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer
  ) {
    return body;
  }
  headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
  return JSON.stringify(body);
}

function createDiscordRequestSignal(options: DiscordApiRequestOptions): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  if (typeof options.timeoutMs !== "number" || options.signal?.aborted) {
    return { signal: options.signal, cleanup: () => undefined };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveTimerTimeoutMs(options.timeoutMs, 1));
  timeout.unref?.();
  return {
    signal: options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

export async function requestDiscord<T>(
  path: string,
  token: string,
  options?: DiscordApiRequestOptions,
): Promise<T> {
  const fetchImpl = resolveFetch(options?.fetcher ?? fetch);
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }

  const retryConfig = resolveRetryConfig(DISCORD_API_RETRY_DEFAULTS, options?.retry);
  return retryAsync(
    async () => {
      const headers = new Headers(options?.headers);
      headers.set("Authorization", `Bot ${token}`);
      const body = normalizeDiscordRequestBody(options?.body, headers);
      const requestSignal = createDiscordRequestSignal(options ?? {});
      try {
        const res = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
          method: options?.method ?? (body === undefined ? "GET" : "POST"),
          headers,
          body,
          signal: requestSignal.signal,
        });
        if (!res.ok) {
          const text = await readResponseTextLimited(res, DISCORD_API_ERROR_BODY_LIMIT_BYTES).catch(
            () => "",
          );
          const detail = formatDiscordApiErrorText(text, res);
          const suffix = detail ? `: ${detail}` : "";
          const retryAfter =
            res.status === 429
              ? (parseRetryAfterSeconds(text, res) ?? DISCORD_API_429_FALLBACK_RETRY_AFTER_SECONDS)
              : undefined;
          throw new DiscordApiError(
            `Discord API ${path} failed (${res.status})${suffix}`,
            res.status,
            retryAfter,
          );
        }
        const responseBody = await readResponseWithLimit(
          res,
          DISCORD_API_RESPONSE_BODY_LIMIT_BYTES,
          {
            onOverflow: ({ size, maxBytes }) =>
              new Error(
                `Discord API ${path} response body too large: ${size} bytes (limit: ${maxBytes} bytes)`,
              ),
          },
        );
        const text = new TextDecoder().decode(responseBody);
        if (!text.trim()) {
          return undefined as T;
        }
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new DiscordApiError(`Discord API ${path} returned malformed JSON`, 0);
        }
      } finally {
        requestSignal.cleanup();
      }
    },
    {
      ...retryConfig,
      label: options?.label ?? path,
      shouldRetry: (err) => err instanceof DiscordApiError && err.status === 429,
      retryAfterMs: (err) => getDiscordApiRetryAfterMs(err, retryConfig),
    },
  );
}

export async function fetchDiscord<T>(
  path: string,
  token: string,
  fetcher: typeof fetch = fetch,
  options?: DiscordFetchOptions,
): Promise<T> {
  return await requestDiscord<T>(path, token, { ...options, fetcher, method: "GET" });
}
