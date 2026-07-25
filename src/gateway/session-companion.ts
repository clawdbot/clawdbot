import type {
  SessionCompanionExchange,
  SessionsCompanionAskResult,
  SessionsCompanionStateResult,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  createSessionCompanionAskRuntime,
  type SessionCompanionAskDeps,
} from "./session-companion-ask.js";
import { onGatewaySessionReset } from "./session-reset-notifications.js";

export type SessionCompanionSeedMessage = {
  role: "user" | "assistant";
  text: string;
  ts: number;
};

export type SessionCompanionThread = {
  exchanges: SessionCompanionExchange[];
  seed: {
    messages: SessionCompanionSeedMessage[];
    digestJson: string;
  };
  lastNoteSequence: number;
  busy: boolean;
  lastUsedAt: number;
};

export type SessionCompanionService = {
  ask: (params: {
    sessionKey: string;
    question: string;
    connId: string;
  }) => Promise<SessionsCompanionAskResult>;
  state: (sessionKey: string) => SessionsCompanionStateResult;
  reset: (sessionKey: string) => void;
  dispose: () => void;
};

export type SessionCompanionDeps = SessionCompanionAskDeps & {
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export const SESSION_COMPANION_MAX_EXCHANGES = 24;
export const SESSION_COMPANION_MAX_EXCHANGE_BYTES = 48 * 1024;
export const SESSION_COMPANION_IDLE_TTL_MS = 2 * 60 * 60_000;
const SESSION_COMPANION_SWEEP_INTERVAL_MS = 10 * 60_000;

function exchangeBytes(exchange: SessionCompanionExchange): number {
  return Buffer.byteLength(exchange.question, "utf8") + Buffer.byteLength(exchange.answer, "utf8");
}

export function trimSessionCompanionExchanges(exchanges: SessionCompanionExchange[]): void {
  let bytes = exchanges.reduce((total, exchange) => total + exchangeBytes(exchange), 0);
  // Dropping the oldest exchange intentionally breaks the replay byte prefix;
  // the count and byte caps take priority once a long-lived thread is bounded.
  while (
    exchanges.length > SESSION_COMPANION_MAX_EXCHANGES ||
    bytes > SESSION_COMPANION_MAX_EXCHANGE_BYTES
  ) {
    const removed = exchanges.shift();
    bytes -= removed ? exchangeBytes(removed) : 0;
  }
}

export function createSessionCompanion(deps: SessionCompanionDeps): SessionCompanionService {
  const now = deps.now ?? Date.now;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const threads = new Map<string, SessionCompanionThread>();
  let disposed = false;
  const askRuntime = createSessionCompanionAskRuntime({
    ...deps,
    now,
    threads,
    isDisposed: () => disposed,
  });

  const reset = (sessionKey: string) => {
    const key = sessionKey.trim();
    if (!key) {
      return;
    }
    askRuntime.cancel(key);
    threads.delete(key);
  };

  const sweep = () => {
    const cutoff = now() - SESSION_COMPANION_IDLE_TTL_MS;
    for (const [sessionKey, thread] of threads) {
      if (!thread.busy && thread.lastUsedAt <= cutoff) {
        reset(sessionKey);
      }
    }
  };
  const sweepTimer = setIntervalFn(sweep, SESSION_COMPANION_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  const unsubscribeReset = onGatewaySessionReset(reset);

  return {
    ask: askRuntime.ask,
    state(sessionKey) {
      const key = sessionKey.trim();
      const thread = threads.get(key);
      if (!thread) {
        return { exchanges: [] };
      }
      thread.lastUsedAt = now();
      return { exchanges: thread.exchanges.map((exchange) => ({ ...exchange })) };
    },
    reset,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearIntervalFn(sweepTimer);
      unsubscribeReset();
      askRuntime.dispose();
      threads.clear();
    },
  };
}
