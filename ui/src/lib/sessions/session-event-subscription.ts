import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../format-error.ts";

type SessionEventSubscriptionScope = {
  client: GatewayBrowserClient;
  epoch: number;
};

type SessionEventSubscriptionOwner = {
  ensure: (scope: SessionEventSubscriptionScope) => Promise<void>;
  reset: () => void;
  dispose: () => void;
};

/** Keeps one acknowledged broad session observer alive for its connection generation. */
export function createSessionEventSubscriptionOwner(params: {
  isCurrent: (scope: SessionEventSubscriptionScope) => boolean;
  onError: (scope: SessionEventSubscriptionScope, error: string | null) => void;
  retryDelayMs: (error: unknown) => number | null;
}): SessionEventSubscriptionOwner {
  let generation = 0;
  let confirmed: SessionEventSubscriptionScope | null = null;
  let pending: { generation: number; promise: Promise<void> } | null = null;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) {
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const isCurrent = (scope: SessionEventSubscriptionScope, expectedGeneration: number): boolean =>
    generation === expectedGeneration && params.isCurrent(scope);

  const ensure = (scope: SessionEventSubscriptionScope): Promise<void> => {
    if (confirmed?.client === scope.client && confirmed.epoch === scope.epoch) {
      return Promise.resolve();
    }
    if (pending?.generation === generation) {
      return pending.promise;
    }
    clearRetry();
    const expectedGeneration = generation;
    const request = (async () => {
      try {
        const response = await scope.client.request<{ subscribed?: boolean }>(
          "sessions.subscribe",
          {},
          { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
        );
        if (!isCurrent(scope, expectedGeneration)) {
          return;
        }
        if (response?.subscribed !== true) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Gateway did not activate the session event subscription",
            retryable: true,
          });
        }
        confirmed = scope;
        params.onError(scope, null);
      } catch (error) {
        if (!isCurrent(scope, expectedGeneration)) {
          return;
        }
        // A connected transport can outlive an application acknowledgement.
        // Only this idempotent observer turns its typed deadline into a retry.
        const failure =
          error instanceof GatewayProtocolRequestTimeoutError
            ? new GatewayRequestError({
                code: error.code,
                message: error.message,
                retryable: true,
              })
            : error;
        params.onError(scope, formatUiError(failure));
        const delayMs = params.retryDelayMs(failure);
        if (delayMs === null || !isCurrent(scope, expectedGeneration)) {
          return;
        }
        // A retired connection must never revive an observer on its replacement.
        retryTimer = globalThis.setTimeout(() => {
          retryTimer = null;
          if (isCurrent(scope, expectedGeneration)) {
            void ensure(scope);
          }
        }, delayMs);
      }
    })().finally(() => {
      if (pending?.promise === request) {
        pending = null;
      }
    });
    pending = { generation: expectedGeneration, promise: request };
    return request;
  };

  const reset = () => {
    generation += 1;
    confirmed = null;
    pending = null;
    clearRetry();
  };

  return { ensure, reset, dispose: reset };
}
