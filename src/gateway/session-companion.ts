import type {
  SessionsCompanionAskResult,
  SessionsCompanionStateResult,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import {
  createSessionCompanionAskRuntime,
  type SessionCompanionAskDeps,
} from "./session-companion-ask.js";
import type { SessionCompanionThread } from "./session-companion-state.js";
import { sessionObserverScopeKey } from "./session-observer-model.js";
import { onGatewaySessionReset } from "./session-reset-notifications.js";

type SessionCompanionTarget = { sessionKey: string; agentId: string };

export type SessionCompanionService = {
  ask: (params: {
    agentId: string;
    sessionKey: string;
    question: string;
    connId: string;
    signal?: AbortSignal;
  }) => Promise<SessionsCompanionAskResult>;
  state: (target: SessionCompanionTarget) => SessionsCompanionStateResult;
  reset: (target: SessionCompanionTarget) => void;
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

  const reset = (
    target: SessionCompanionTarget,
    cancellation: "backing-session-revoked" | "explicit-reset",
  ) => {
    const sessionKey = target.sessionKey.trim();
    const agentId = target.agentId.trim();
    if (!sessionKey || !agentId) {
      return;
    }
    const key = sessionObserverScopeKey(sessionKey, agentId);
    askRuntime.cancel(sessionKey, agentId, cancellation);
    threads.delete(key);
  };

  const sweep = () => {
    const cutoff = now() - SESSION_COMPANION_IDLE_TTL_MS;
    for (const [key, thread] of threads) {
      if (!thread.busy && thread.lastUsedAt <= cutoff) {
        threads.delete(key);
      }
    }
  };
  const sweepTimer = setIntervalFn(sweep, SESSION_COMPANION_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  const unsubscribeReset = onGatewaySessionReset((sessionKey, suppliedAgentId) => {
    let agentId = suppliedAgentId;
    try {
      agentId ??= resolveSessionAgentId({ sessionKey, config: deps.getConfig() });
    } catch {
      return;
    }
    reset({ sessionKey, agentId }, "backing-session-revoked");
  });

  return {
    ask: askRuntime.ask,
    state(target) {
      const key = sessionObserverScopeKey(target.sessionKey.trim(), target.agentId.trim());
      const thread = threads.get(key);
      if (!thread) {
        return { exchanges: [] };
      }
      thread.lastUsedAt = now();
      return {
        exchanges: thread.exchanges.map(({ question, answer, ts }) => ({ question, answer, ts })),
      };
    },
    reset(target) {
      reset(target, "explicit-reset");
    },
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
