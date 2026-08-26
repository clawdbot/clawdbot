import { computeBackoff } from "@openclaw/retry";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChatHost } from "./chat-send-contract.ts";

type RetryTimer = {
  timer: ReturnType<typeof setTimeout>;
  suppressGenericWake: boolean;
  connectionEpoch: number | undefined;
  host: ChatHost;
};

type RetryState = {
  attempts: Map<string, number>;
  timers: Map<string, RetryTimer>;
};

const RETRY_DEFAULT_MS = 500;
const RETRY_MAX_MS = 30_000;
const retryStates = new WeakMap<GatewayBrowserClient, RetryState>();

function retryState(client: GatewayBrowserClient): RetryState {
  const state = retryStates.get(client) ?? { attempts: new Map(), timers: new Map() };
  retryStates.set(client, state);
  return state;
}

function retryOwnerStale(client: GatewayBrowserClient, retry: RetryTimer): boolean {
  return (
    !retry.host.connected ||
    retry.host.client !== client ||
    retry.connectionEpoch !== retry.host.connectionEpoch
  );
}

export function retryableGatewayDelayMs(err: unknown): number | null {
  if (!(err instanceof GatewayRequestError) || !err.retryable) {
    return null;
  }
  return Math.min(Math.max(err.retryAfterMs ?? RETRY_DEFAULT_MS, 100), RETRY_MAX_MS);
}

export function scheduleChatOutboxRetry(
  host: ChatHost,
  key: string,
  delayMs: number,
  wake: (host: ChatHost) => void,
  suppressGenericWake: boolean,
): void {
  const client = host.client;
  if (!host.connected || !client) {
    return;
  }
  const state = retryState(client);
  if (state.timers.has(key)) {
    return;
  }
  const attempt = (state.attempts.get(key) ?? 0) + 1;
  const retryDelayMs = suppressGenericWake
    ? computeBackoff({ initialMs: delayMs, maxMs: RETRY_MAX_MS, factor: 2, jitter: 0 }, attempt)
    : delayMs;
  if (suppressGenericWake) {
    state.attempts.set(key, attempt);
  } else {
    state.attempts.delete(key);
  }
  const retry: RetryTimer = {
    timer: setTimeout(() => {
      state.timers.delete(key);
      if (!retryOwnerStale(client, retry)) {
        wake(retry.host);
      }
    }, retryDelayMs),
    suppressGenericWake,
    connectionEpoch: host.connectionEpoch,
    host,
  };
  state.timers.set(key, retry);
}

export function consumeChatOutboxRetry(
  host: ChatHost,
  key: string,
  candidateOwnsScope: boolean,
  itemId?: string,
): boolean {
  const client = host.client;
  if (!client) {
    return false;
  }
  const state = retryState(client);
  const retry = state.timers.get(key);
  if (!retry) {
    return false;
  }
  const ownerStale = retryOwnerStale(client, retry);
  if (!ownerStale && candidateOwnsScope) {
    retry.connectionEpoch = host.connectionEpoch;
    retry.host = host;
  }
  if (!itemId && !ownerStale && retry.suppressGenericWake) {
    return true;
  }
  clearTimeout(retry.timer);
  state.timers.delete(key);
  if (itemId || ownerStale) {
    state.attempts.delete(key);
  }
  return false;
}

export function settleChatOutboxRetry(client: GatewayBrowserClient, key: string): void {
  const state = retryState(client);
  if (!state.timers.has(key)) {
    state.attempts.delete(key);
  }
}
