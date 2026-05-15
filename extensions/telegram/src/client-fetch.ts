import type { ApiClientOptions } from "grammy";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TelegramTransport } from "./fetch.js";
import { tagTelegramNetworkError } from "./network-errors.js";
import { resolveTelegramRequestTimeoutMs } from "./request-timeouts.js";

type TelegramFetchInput = Parameters<NonNullable<ApiClientOptions["fetch"]>>[0];
type TelegramFetchInit = Parameters<NonNullable<ApiClientOptions["fetch"]>>[1];
type TelegramClientFetch = NonNullable<ApiClientOptions["fetch"]>;
type TelegramCompatFetch = (
  input: TelegramFetchInput,
  init?: TelegramFetchInit,
) => ReturnType<TelegramClientFetch>;
type TelegramAbortSignalLike = {
  aborted: boolean;
  reason?: unknown;
  addEventListener: (type: "abort", listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener: (type: "abort", listener: () => void) => void;
};

export function asTelegramClientFetch(
  fetchImpl: TelegramCompatFetch | typeof globalThis.fetch,
): TelegramClientFetch {
  return fetchImpl as unknown as TelegramClientFetch;
}

function asTelegramCompatFetch(fetchImpl: TelegramClientFetch): TelegramCompatFetch {
  return fetchImpl as unknown as TelegramCompatFetch;
}

function isTelegramAbortSignalLike(value: unknown): value is TelegramAbortSignalLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as { aborted?: unknown }).aborted === "boolean" &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function" &&
    typeof (value as { removeEventListener?: unknown }).removeEventListener === "function"
  );
}

function readRequestUrl(input: TelegramFetchInput): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return null;
}

function extractTelegramApiMethod(input: TelegramFetchInput): string | null {
  const url = readRequestUrl(input);
  if (!url) {
    return null;
  }
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const method = segments.length > 0 ? (segments.at(-1) ?? null) : null;
    return normalizeOptionalLowercaseString(method) ?? null;
  } catch {
    return null;
  }
}

const TELEGRAM_TIMEOUT_FALLBACK_METHODS = new Set([
  "deletemycommands",
  "deletewebhook",
  "getme",
  "sendchataction",
  "setmycommands",
  "setwebhook",
]);

function shouldRetryTimedOutTelegramControlRequest(method: string | null): boolean {
  return method !== null && TELEGRAM_TIMEOUT_FALLBACK_METHODS.has(method);
}

export function resolveTelegramClientTimeoutSeconds(params: {
  value: unknown;
  minimum?: number;
}): number | undefined {
  const { value, minimum } = params;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const configured = Math.max(1, Math.floor(value));
  if (typeof minimum !== "number" || !Number.isFinite(minimum)) {
    return configured;
  }
  return Math.max(configured, Math.max(1, Math.floor(minimum)));
}

export function resolveTelegramClientTimeoutMinimumSeconds(
  values: readonly (number | undefined)[],
) {
  let minimum: number | undefined;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    const normalized = Math.max(1, Math.ceil(value));
    minimum = minimum === undefined ? normalized : Math.max(minimum, normalized);
  }
  return minimum;
}

export function resolveTelegramOutboundClientTimeoutFloorSeconds(timeoutSeconds: unknown) {
  const timeoutMs = resolveTelegramRequestTimeoutMs("sendmessage", timeoutSeconds);
  return timeoutMs === undefined ? undefined : timeoutMs / 1000;
}

export function createTelegramClientFetch(params: {
  fetchImpl?: TelegramClientFetch;
  timeoutSeconds?: unknown;
  shutdownSignal?: unknown;
  transport?: Pick<TelegramTransport, "forceFallback">;
}): TelegramCompatFetch | undefined {
  if (!params.fetchImpl && !params.shutdownSignal) {
    return undefined;
  }

  const callFetch = asTelegramCompatFetch(
    params.fetchImpl ?? asTelegramClientFetch(globalThis.fetch),
  );
  const wrappedFetch = async (input: TelegramFetchInput, init?: TelegramFetchInit) => {
    const method = extractTelegramApiMethod(input);
    const requestTimeoutMs = resolveTelegramRequestTimeoutMs(method, params.timeoutSeconds);
    const shutdownSignal = isTelegramAbortSignalLike(params.shutdownSignal)
      ? params.shutdownSignal
      : undefined;
    const requestSignal = isTelegramAbortSignalLike(init?.signal) ? init.signal : undefined;

    const runFetch = async () => {
      const controller = new AbortController();
      const abortWith = (signal: Pick<TelegramAbortSignalLike, "reason">) =>
        controller.abort(signal.reason);
      const onShutdown = () => {
        if (shutdownSignal) {
          abortWith(shutdownSignal);
        }
      };
      let requestTimeout: ReturnType<typeof setTimeout> | undefined;
      let onRequestAbort: (() => void) | undefined;
      let requestTimedOut = false;
      const timeoutError =
        requestTimeoutMs !== undefined
          ? new Error(`Telegram ${method} timed out after ${requestTimeoutMs}ms`)
          : undefined;

      if (shutdownSignal?.aborted) {
        abortWith(shutdownSignal);
      } else if (shutdownSignal) {
        shutdownSignal.addEventListener("abort", onShutdown, { once: true });
      }
      if (requestSignal) {
        if (requestSignal.aborted) {
          abortWith(requestSignal);
        } else {
          onRequestAbort = () => abortWith(requestSignal);
          requestSignal.addEventListener("abort", onRequestAbort);
        }
      }
      if (requestTimeoutMs && timeoutError) {
        requestTimeout = setTimeout(() => {
          requestTimedOut = true;
          controller.abort(timeoutError);
        }, requestTimeoutMs);
        requestTimeout.unref?.();
      }

      try {
        return await callFetch(input, {
          ...init,
          signal: controller.signal,
        });
      } catch (err) {
        if (requestTimedOut && timeoutError) {
          throw timeoutError;
        }
        throw err;
      } finally {
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
        shutdownSignal?.removeEventListener("abort", onShutdown);
        if (requestSignal && onRequestAbort) {
          requestSignal.removeEventListener("abort", onRequestAbort);
        }
      }
    };

    try {
      return await runFetch();
    } catch (err) {
      if (
        requestTimeoutMs &&
        shouldRetryTimedOutTelegramControlRequest(method) &&
        !shutdownSignal?.aborted &&
        !requestSignal?.aborted &&
        params.transport?.forceFallback?.("request-timeout")
      ) {
        return await runFetch();
      }
      throw err;
    }
  };

  return (input: TelegramFetchInput, init?: TelegramFetchInit) => {
    return Promise.resolve(wrappedFetch(input, init)).catch((err: unknown) => {
      try {
        tagTelegramNetworkError(err, {
          method: extractTelegramApiMethod(input),
          url: readRequestUrl(input),
        });
      } catch {
        // Tagging is best-effort; preserve the original fetch failure if the
        // error object cannot accept extra metadata.
      }
      throw err;
    });
  };
}
