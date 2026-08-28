import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";

type ApplicationInitialUserMessage = {
  role: "user";
  content: unknown[];
  timestamp: number;
  __openclaw?: { idempotencyKey?: string; seq?: number };
};

type ApplicationInitialUserMessageHandoffEntry = {
  message: ApplicationInitialUserMessage;
  pendingRunId: string;
  /** Logical Gateway client; per-transport hello objects rotate on reconnect. */
  owner: object;
  sessionKey: string;
};

export type ApplicationInitialUserMessageHandoff = {
  prepare: (handoff: ApplicationInitialUserMessageHandoffEntry) => void;
  read: (
    sessionKey: string,
    owner: object | null,
  ) => ApplicationInitialUserMessageHandoffEntry | null;
  clear: (sessionKey?: string) => void;
};

// Terminal history removes normal entries; this cap bounds abandoned active-session handoffs.
const MAX_PENDING_INITIAL_USER_MESSAGES = 32;

export function createInitialUserMessageHandoff(): ApplicationInitialUserMessageHandoff {
  const pending = new Map<string, Parameters<ApplicationInitialUserMessageHandoff["prepare"]>[0]>();
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
      if (existingKey) {
        pending.delete(existingKey);
      }
      pending.set(handoff.sessionKey, handoff);
      while (pending.size > MAX_PENDING_INITIAL_USER_MESSAGES) {
        const oldestKey = pending.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        pending.delete(oldestKey);
      }
    },
    read: (sessionKey, owner) => {
      const handoff = pending.get(findKey(sessionKey) ?? "");
      return handoff && handoff.owner === owner ? handoff : null;
    },
    clear: (sessionKey) => {
      if (sessionKey === undefined) {
        pending.clear();
        return;
      }
      const key = findKey(sessionKey);
      if (key) {
        pending.delete(key);
      }
    },
  };
}
