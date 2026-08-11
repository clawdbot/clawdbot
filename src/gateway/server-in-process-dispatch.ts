import { randomUUID } from "node:crypto";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createAbortError } from "../infra/abort-signal.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import type { GatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

export type GatewayMethodDispatchResponse = {
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
  meta?: Record<string, unknown>;
};

type InProcessGatewayDispatchOptions = {
  client: GatewayRequestOptions["client"];
  context: GatewayRequestOptions["context"];
  expectFinal?: boolean;
  isWebchatConnect?: GatewayRequestOptions["isWebchatConnect"];
  methodRegistry?: GatewayMethodRegistry;
  onAccepted?: (payload: unknown) => void;
  onSignalAbort?: () => Promise<void> | void;
  requestIdPrefix?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export function unwrapGatewayMethodDispatchResponse(
  method: string,
  response: GatewayMethodDispatchResponse,
): unknown {
  if (!response.ok) {
    const requestError = new GatewayClientRequestError({
      code: response.error?.code,
      message: response.error?.message ?? `Gateway method "${method}" failed.`,
      details: response.error?.details,
      retryable: response.error?.retryable,
      retryAfterMs: response.error?.retryAfterMs,
    });
    const cause = (response.error as (ErrorShape & { cause?: unknown }) | undefined)?.cause;
    if (cause !== undefined) {
      Object.defineProperty(requestError, "cause", { value: cause });
    }
    throw requestError;
  }
  return response.payload;
}

function resolveDispatchDeadlineMs(timeoutMs?: number): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  return Date.now() + resolveSafeTimeoutDelayMs(timeoutMs);
}

function resolveRemainingDispatchTimeoutMs(deadlineMs?: number): number | undefined {
  return deadlineMs === undefined
    ? undefined
    : resolveSafeTimeoutDelayMs(deadlineMs - Date.now(), { minMs: 0 });
}

function resolveDispatchAbortError(method: string, signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createAbortError(`gateway request aborted for ${method}`, { cause: signal.reason });
}

/** Reject before a cancelled in-process request can invoke method work. */
export function throwIfGatewayDispatchAborted(method: string, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw resolveDispatchAbortError(method, signal);
  }
}

async function waitForDispatch<T>(
  method: string,
  promise: Promise<T>,
  deadlineMs?: number,
  signal?: AbortSignal,
  onSignalAbort?: () => Promise<void> | void,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) {
      throw resolveDispatchAbortError(method, signal);
    }
    const remainingTimeoutMs = resolveRemainingDispatchTimeoutMs(deadlineMs);
    if (remainingTimeoutMs === undefined && !signal) {
      return await promise;
    }
    const cancellation = new Promise<never>((_resolve, reject) => {
      if (remainingTimeoutMs !== undefined) {
        timeout = setTimeout(() => {
          reject(new Error(`gateway request timeout for ${method}`));
        }, remainingTimeoutMs);
      }
      if (signal) {
        onAbort = () => reject(resolveDispatchAbortError(method, signal));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }
    });
    return await Promise.race([promise, cancellation]);
  } catch (error) {
    if (signal?.aborted && onSignalAbort) {
      await Promise.resolve()
        .then(onSignalAbort)
        .catch(() => {});
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Applies the same non-cancelling deadline used by in-process Gateway dispatch. */
export async function waitForGatewayDispatch<T>(
  method: string,
  promise: Promise<T>,
  timeoutMs?: number,
  signal?: AbortSignal,
  onSignalAbort?: () => Promise<void> | void,
): Promise<T> {
  return await waitForDispatch(
    method,
    promise,
    resolveDispatchDeadlineMs(timeoutMs),
    signal,
    onSignalAbort,
  );
}

/** Dispatches one request through the ordinary Gateway router without opening a transport. */
export async function dispatchGatewayRequestInProcessRaw(
  method: string,
  params: unknown,
  options: InProcessGatewayDispatchOptions,
): Promise<GatewayMethodDispatchResponse> {
  throwIfGatewayDispatchAborted(method, options.signal);
  let firstResponse: GatewayMethodDispatchResponse | undefined;
  let finalResponse: GatewayMethodDispatchResponse | undefined;
  let resolveFirstResponse: ((response: GatewayMethodDispatchResponse) => void) | undefined;
  let rejectFirstResponse: ((err: Error) => void) | undefined;
  let resolveFinalResponse: ((response: GatewayMethodDispatchResponse) => void) | undefined;
  let rejectFinalResponse: ((err: Error) => void) | undefined;
  let postFirstResponseError: Error | undefined;
  const firstResponsePromise = new Promise<GatewayMethodDispatchResponse>((resolve, reject) => {
    resolveFirstResponse = resolve;
    rejectFirstResponse = reject;
  });
  const deadlineMs = resolveDispatchDeadlineMs(options.timeoutMs);
  const { handleGatewayRequest } = await import("./server-methods.js");
  void handleGatewayRequest({
    req: {
      type: "req",
      id: `${options.requestIdPrefix ?? "in-process"}-${randomUUID()}`,
      method,
      params,
    },
    client: options.client,
    isWebchatConnect: options.isWebchatConnect ?? (() => false),
    respond: (ok, payload, error, meta) => {
      const response = { ok, payload, error, ...(meta ? { meta } : {}) };
      if (!firstResponse) {
        firstResponse = response;
        resolveFirstResponse?.(response);
        return;
      }
      if (!finalResponse) {
        finalResponse = response;
        resolveFinalResponse?.(response);
      }
    },
    context: options.context,
    methodRegistry: options.methodRegistry,
    ...(options.signal ? { signal: options.signal } : {}),
  })
    .then(() => {
      if (!firstResponse) {
        rejectFirstResponse?.(
          new Error(`Gateway method "${method}" completed without a response.`),
        );
      }
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!firstResponse) {
        rejectFirstResponse?.(error);
        return;
      }
      postFirstResponseError = error;
      rejectFinalResponse?.(error);
    });

  firstResponse = await waitForDispatch(
    method,
    firstResponsePromise,
    deadlineMs,
    options.signal,
    options.onSignalAbort,
  );
  const firstPayload = firstResponse.payload as { status?: unknown } | undefined;
  if (options.expectFinal !== true || firstPayload?.status !== "accepted") {
    return firstResponse;
  }
  options.onAccepted?.(firstResponse.payload);
  if (postFirstResponseError) {
    throw postFirstResponseError;
  }
  return (
    finalResponse ??
    (await waitForDispatch(
      method,
      new Promise<GatewayMethodDispatchResponse>((resolve, reject) => {
        resolveFinalResponse = resolve;
        rejectFinalResponse = reject;
        if (postFirstResponseError) {
          reject(postFirstResponseError);
          return;
        }
        if (finalResponse) {
          resolve(finalResponse);
        }
      }),
      deadlineMs,
      options.signal,
      options.onSignalAbort,
    ))
  );
}

export async function dispatchGatewayRequestInProcess<T>(
  method: string,
  params: unknown,
  options: InProcessGatewayDispatchOptions,
): Promise<T> {
  return unwrapGatewayMethodDispatchResponse(
    method,
    await dispatchGatewayRequestInProcessRaw(method, params, options),
  ) as T;
}
