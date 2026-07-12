// Fetch timeout helpers wrap fetch calls with timeout and abort behavior.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveSafeTimeoutDelayMs } from "./timer-delay.js";

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

/** Relays a parent abort while preserving its reason. */
function relayAbortReason(this: AbortController, signal: AbortSignal) {
  this.abort(signal.reason);
}

function sanitizeTimeoutLogUrl(rawUrl: string | undefined): string | undefined {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    // Strip credentials, query, and fragment before logging; timeout URLs often
    // include provider tokens or signed request parameters.
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const value = redactSensitiveUrlLikeString(parsed.toString());
    return value.length > LOG_URL_MAX_CHARS
      ? `${truncateUtf16Safe(value, LOG_URL_MAX_CHARS)}...`
      : value;
  } catch {
    const withoutQueryOrHash = trimmed.split(URL_SECRET_SUFFIX_PATTERN, 1)[0] ?? "";
    const cleaned = redactSensitiveUrlLikeString(
      withoutQueryOrHash
        .replace(/[\r\n\u2028\u2029]+/g, " ")
        .replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (!cleaned) {
      return undefined;
    }
    return cleaned.length > LOG_URL_MAX_CHARS
      ? `${truncateUtf16Safe(cleaned, LOG_URL_MAX_CHARS)}...`
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
  // A large elapsed/timeout gap means the timer callback itself was starved,
  // which is more useful for operators than another plain timeout message.
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

/**
 * Builds an abort signal that combines an optional parent signal with a timeout.
 * Callers must run `cleanup`; `refresh` restarts only the internal timeout timer.
 */
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
  const normalizedTimeoutMs = resolveSafeTimeoutDelayMs(timeoutMs);
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
  const onAbort = signal ? relayAbortReason.bind(controller, signal) : undefined;
  if (signal && onAbort) {
    if (signal.aborted) {
      controller.abort(signal.reason);
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
      if (signal && onAbort) {
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
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: Math.max(1, timeoutMs),
    operation: "fetchWithTimeout",
    url,
  });
  const callerSignal = init.signal ?? undefined;
  // The wrapper timeout ends once fetch returns headers, but the response body
  // must keep following caller cancellation (and its reason) after that point.
  const signal =
    callerSignal && timeoutSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : (callerSignal ?? timeoutSignal);
  try {
    return await fetchFn(url, { ...init, signal });
  } finally {
    cleanup();
  }
}
