import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";

export type ApplicationInitialUserMessage = {
  role: "user";
  content: unknown[];
  timestamp: number;
  __openclaw?: { idempotencyKey?: string; seq?: number };
};

type InitialUserMessageHandoff = {
  message: ApplicationInitialUserMessage;
  /** Logical Gateway client; per-transport hello objects rotate on reconnect. */
  owner: object;
  sessionKey: string;
};

export type ApplicationInitialUserMessageHandoff = {
  prepare: (handoff: InitialUserMessageHandoff) => void;
  read: (sessionKey: string, owner: object | null) => ApplicationInitialUserMessage | null;
  clear: (sessionKey?: string) => void;
  subscribe: (listener: () => void) => () => void;
};

// Terminal history removes normal entries; this cap bounds abandoned active-session handoffs.
const MAX_PENDING_INITIAL_USER_MESSAGES = 32;

export function createInitialUserMessageHandoff(): ApplicationInitialUserMessageHandoff {
  const pending = new Map<
    string,
    Pick<Parameters<ApplicationInitialUserMessageHandoff["prepare"]>[0], "message" | "owner">
  >();
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const findKey = (sessionKey: string) => {
    for (const candidate of pending.keys()) {
      if (areUiSessionKeysEquivalent(candidate, sessionKey)) {
        return candidate;
      }
    }
    return undefined;
  };
  return {
    prepare: (handoff) => {
      const existingKey = findKey(handoff.sessionKey);
      const existing = existingKey ? pending.get(existingKey) : undefined;
      if (existing?.message === handoff.message && existing.owner === handoff.owner) {
        return;
      }
      if (existingKey) {
        pending.delete(existingKey);
      }
      pending.set(handoff.sessionKey, { message: handoff.message, owner: handoff.owner });
      while (pending.size > MAX_PENDING_INITIAL_USER_MESSAGES) {
        const oldestKey = pending.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        pending.delete(oldestKey);
      }
      publish();
    },
    read: (sessionKey, owner) => {
      const handoff = pending.get(findKey(sessionKey) ?? "");
      return handoff && handoff.owner === owner ? handoff.message : null;
    },
    clear: (sessionKey) => {
      if (sessionKey === undefined) {
        if (pending.size === 0) {
          return;
        }
        pending.clear();
        publish();
        return;
      }
      const key = findKey(sessionKey);
      if (key) {
        pending.delete(key);
        publish();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
