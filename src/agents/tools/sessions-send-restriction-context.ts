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
  return activeContext.run({ ...activeContext.getStore(), ...context }, run);
}

export function captureSessionsSendRestrictionContext(): SessionsSendRestrictionContext {
  return { ...activeContext.getStore() };
}
