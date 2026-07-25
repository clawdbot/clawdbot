import { randomUUID } from "node:crypto";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/index.js";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
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
  requestIdPrefix?: string;
  timeoutMs?: number;
};

export function unwrapGatewayMethodDispatchResponse(
  method: string,
  response: GatewayMethodDispatchResponse,
): unknown {
  if (!response.ok) {
    throw new GatewayClientRequestError({
      code: response.error?.code,
      message: response.error?.message ?? `Gateway method "${method}" failed.`,
      details: response.error?.details,
      retryable: response.error?.retryable,
      retryAfterMs: response.error?.retryAfterMs,
    });
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

async function waitForDispatch<T>(
  method: string,
  promise: Promise<T>,
  deadlineMs?: number,
): Promise<T> {
  const remainingTimeoutMs = resolveRemainingDispatchTimeoutMs(deadlineMs);
  if (remainingTimeoutMs === undefined) {
    return await promise;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`gateway request timeout for ${method}`));
        }, remainingTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Dispatches one request through the ordinary Gateway router without opening a transport. */
export async function dispatchGatewayRequestInProcessRaw(
  method: string,
  params: unknown,
  options: InProcessGatewayDispatchOptions,
): Promise<GatewayMethodDispatchResponse> {
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

  firstResponse = await waitForDispatch(method, firstResponsePromise, deadlineMs);
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
    (await new Promise<GatewayMethodDispatchResponse>((resolve, reject) => {
      resolveFinalResponse = resolve;
      const timeoutMs = resolveRemainingDispatchTimeoutMs(deadlineMs);
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => reject(new Error(`gateway request timeout for ${method}`)), timeoutMs);
      const clearFinalTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
      };
      rejectFinalResponse = (err) => {
        clearFinalTimeout();
        reject(err);
      };
      if (postFirstResponseError) {
        rejectFinalResponse(postFirstResponseError);
        return;
      }
      if (finalResponse) {
        clearFinalTimeout();
        resolve(finalResponse);
        return;
      }
      resolveFinalResponse = (response) => {
        clearFinalTimeout();
        resolve(response);
      };
    }))
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
