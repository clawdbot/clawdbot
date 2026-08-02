import { AsyncLocalStorage } from "node:async_hooks";

type SessionsSendRestrictionContext = {
  agentSessionId?: string;
  callerSessionKey?: string;
};

const activeContext = new AsyncLocalStorage<SessionsSendRestrictionContext>();

export function withSessionsSendRestrictionContext<T>(
  context: SessionsSendRestrictionContext,
  run: () => T,
): T {
  const nextContext = { ...activeContext.getStore() };
  if (context.agentSessionId) {
    nextContext.agentSessionId = context.agentSessionId;
  }
  if (context.callerSessionKey) {
    nextContext.callerSessionKey = context.callerSessionKey;
  }
  return activeContext.run(nextContext, run);
}

export function captureSessionsSendRestrictionContext(): SessionsSendRestrictionContext {
  return { ...activeContext.getStore() };
}
