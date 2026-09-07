import { emitModelTransportDebug } from "@openclaw/ai/transports";
import type { GuardedFetchOptions, GuardedFetchResult } from "../infra/net/fetch-guard.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { Model } from "../llm/types.js";
import type { SubsystemLogger } from "../logging/subsystem.js";

/**
 * Pre-stream 5xx statuses eligible for the bounded transport-level retry.
 * Transient gateway/provider blunders (500/502/503/504) returned as plain
 * error bodies before any SSE stream starts mean the provider never began
 * processing the request, so a bounded replay is safe.
 */
const TRANSPORT_5XX_RETRY_STATUSES = new Set([500, 502, 503, 504]);

/** Bounded backoff schedule (ms) for the transport-level 5xx retry. */
const TRANSPORT_5XX_RETRY_DELAY_MS = [2_000, 5_000];

function isReplayableModelFetchBody(init: GuardedFetchOptions["init"]): boolean {
  const body = (init as { body?: unknown } | undefined)?.body;
  return (
    body == null ||
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  );
}

function isPreStreamPlainErrorResponse(response: Response): boolean {
  return (
    TRANSPORT_5XX_RETRY_STATUSES.has(response.status) &&
    !/\btext\/event-stream\b/i.test(response.headers.get("content-type") ?? "")
  );
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry transient pre-stream 5xx responses up to twice with bounded backoff.
 *
 * Only plain (non-SSE) error bodies are retried — an SSE response means the
 * provider accepted and started the request, where a replay could duplicate
 * model work. Only replayable request bodies (string/Uint8Array/ArrayBuffer/
 * null) are retried. Each retry re-issues the same guarded fetch options, so
 * SSRF policy, dispatcher pool, and the per-attempt timeout budget all apply;
 * the discarded attempt's dispatcher lease is released before re-fetching, and
 * the final attempt's result is returned so the caller wires its release into
 * the managed response as usual.
 */
export async function retryTransientPreStream5xx(params: {
  model: Model;
  result: GuardedFetchResult;
  response: Response;
  guardedFetchOptions: GuardedFetchOptions;
  log: SubsystemLogger;
  fetchStartedAt: number;
  signal?: AbortSignal;
}): Promise<{ result: GuardedFetchResult; response: Response }> {
  const { model, guardedFetchOptions, log } = params;
  let current = params.result;
  let response = params.response;
  if (!isReplayableModelFetchBody(guardedFetchOptions.init)) {
    return { result: current, response };
  }
  for (const [attempt, delay] of TRANSPORT_5XX_RETRY_DELAY_MS.entries()) {
    if (params.signal?.aborted || !isPreStreamPlainErrorResponse(response)) {
      return { result: current, response };
    }
    log.warn(
      `[model-fetch] transient ${response.status} from provider=${model.provider} ` +
        `api=${model.api} model=${model.id} — transport retry ` +
        `${attempt + 1}/${TRANSPORT_5XX_RETRY_DELAY_MS.length} in ${delay}ms`,
    );
    await sleepAbortable(delay, params.signal);
    if (params.signal?.aborted) {
      return { result: current, response };
    }
    // The discarded attempt's dispatcher lease is released together with its
    // unread error body; the retried request re-enters the guarded fetch with
    // the same options (SSRF policy, dispatcher pool, timeout budget).
    await current.release().catch(() => undefined);
    current = await fetchWithSsrFGuard(guardedFetchOptions);
    response = current.response;
    emitModelTransportDebug(
      log,
      `[model-fetch] response provider=${model.provider} api=${model.api} model=${model.id} ` +
        `status=${response.status} elapsedMs=${Date.now() - params.fetchStartedAt} ` +
        `dispatcher=${current.dispatcherReused ? "reused" : "new"} ` +
        `contentType=${response.headers.get("content-type") ?? ""} ` +
        `transportRetry=${attempt + 1}`,
    );
  }
  return { result: current, response };
}
