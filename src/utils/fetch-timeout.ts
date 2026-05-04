import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("fetch-timeout");
const LOG_URL_MAX_CHARS = 500;
const URL_SECRET_SUFFIX_PATTERN = /[?#]/;

type TimeoutAbortSignalParams = {
  timeoutMs?: number;
  signal?: AbortSignal;
  operation?: string;
  url?: string;
};

/**
 * Relay abort without forwarding the Event argument as the abort reason.
 * Using .bind() avoids closure scope capture (memory leak prevention).
 */
function relayAbort(this: AbortController) {
  this.abort();
}

/** Returns a bound abort relay for use as an event listener. */
export function bindAbortRelay(controller: AbortController): () => void {
  return relayAbort.bind(controller);
}

function sanitizeTimeoutLogUrl(rawUrl: string | undefined): string | undefined {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const value = parsed.toString();
    return value.length > LOG_URL_MAX_CHARS ? `${value.slice(0, LOG_URL_MAX_CHARS)}...` : value;
  } catch {
    const withoutQueryOrHash = trimmed.split(URL_SECRET_SUFFIX_PATTERN, 1)[0] ?? "";
    const cleaned = withoutQueryOrHash
      .replace(/[\r\n\u2028\u2029]+/g, " ")
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) {
      return undefined;
    }
    return cleaned.length > LOG_URL_MAX_CHARS
      ? `${cleaned.slice(0, LOG_URL_MAX_CHARS)}...`
      : cleaned;
  }
}

function abortDueToTimeout(
  controller: AbortController,
  timeoutMs: number,
  startedAtMs: number,
  operation?: string,
  url?: string,
) {
  if (controller.signal.aborted) {
    return;
  }
  const sanitizedUrl = sanitizeTimeoutLogUrl(url);
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const delayMs = Math.max(0, elapsedMs - timeoutMs);
  const eventLoopDelayHint =
    delayMs >= Math.max(1000, timeoutMs * 0.5)
      ? `timer delayed ${delayMs}ms, likely event-loop starvation`
      : null;
  const consoleMessage = [
    `fetch timeout after ${timeoutMs}ms`,
    `(elapsed ${elapsedMs}ms)`,
    eventLoopDelayHint,
    operation ? `operation=${operation}` : null,
    sanitizedUrl ? `url=${sanitizedUrl}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  log.warn("fetch timeout reached; aborting operation", {
    timeoutMs,
    elapsedMs,
    ...(eventLoopDelayHint ? { timerDelayMs: delayMs, eventLoopDelayHint } : {}),
    consoleMessage,
    ...(operation ? { operation } : {}),
    ...(sanitizedUrl ? { url: sanitizedUrl } : {}),
  });
  const error = new Error("request timed out");
  error.name = "TimeoutError";
  controller.abort(error);
}

export function buildTimeoutAbortSignal(params: TimeoutAbortSignalParams): {
  signal?: AbortSignal;
  cleanup: () => void;
  refresh: () => void;
} {
  const { timeoutMs, signal } = params;
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: () => {}, refresh: () => {} };
  }
  if (!timeoutMs) {
    return { signal, cleanup: () => {}, refresh: () => {} };
  }

  const controller = new AbortController();
  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  let active = true;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const scheduleTimeout = () => {
    timeoutId = setTimeout(
      abortDueToTimeout,
      normalizedTimeoutMs,
      controller,
      normalizedTimeoutMs,
      Date.now(),
      params.operation,
      params.url,
    );
  };
  scheduleTimeout();
  const onAbort = bindAbortRelay(controller);
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    refresh: () => {
      if (!active || controller.signal.aborted) {
        return;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      scheduleTimeout();
    },
    cleanup: () => {
      active = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Fetch wrapper that adds timeout support via AbortController.
 *
 * @param url - The URL to fetch
 * @param init - RequestInit options (headers, method, body, etc.)
 * @param timeoutMs - Timeout in milliseconds
 * @param fetchFn - The fetch implementation to use (defaults to global fetch)
 * @returns The fetch Response
 * @throws AbortError if the request times out
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: Math.max(1, timeoutMs),
    operation: "fetchWithTimeout",
    url,
  });
  try {
    return await fetchFn(url, { ...init, signal });
  } finally {
    cleanup();
  }
}
