import type {
  SessionsCompanionAskResult,
  SessionsCompanionStateResult,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  createSessionCompanionAskRuntime,
  type SessionCompanionAskDeps,
} from "./session-companion-ask.js";
import type { SessionCompanionThread } from "./session-companion-state.js";
import { onGatewaySessionReset } from "./session-reset-notifications.js";

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

type SessionCompanionDeps = SessionCompanionAskDeps & {
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

const SESSION_COMPANION_IDLE_TTL_MS = 2 * 60 * 60_000;
const SESSION_COMPANION_SWEEP_INTERVAL_MS = 10 * 60_000;

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
      return {
        exchanges: thread.exchanges.map(({ question, answer, ts }) => ({ question, answer, ts })),
      };
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
