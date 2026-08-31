import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";

type ApplicationInitialUserMessage = {
  role: "user";
  content: unknown[];
  timestamp: number;
  __openclaw?: { idempotencyKey?: string };
};

type ApplicationInitialUserMessageHandoffEntry = {
  message: ApplicationInitialUserMessage;
  pendingRunId: string;
  pending: boolean;
  /** Logical Gateway client; per-transport hello objects rotate on reconnect. */
  owner: object;
  sessionKey: string;
};

export type ApplicationInitialUserMessageHandoff = {
  prepare: (handoff: Omit<ApplicationInitialUserMessageHandoffEntry, "pending">) => void;
  read: (
    sessionKey: string,
    owner: object | null,
  ) => ApplicationInitialUserMessageHandoffEntry | null;
  retire: (sessionKey: string, owner: object | null, runId: string) => void;
  clear: (sessionKey?: string) => void;
};

// Terminal history removes normal entries; this cap bounds abandoned active-session handoffs.
const MAX_PENDING_INITIAL_USER_MESSAGES = 32;

export function createInitialUserMessageHandoff(): ApplicationInitialUserMessageHandoff {
  const pending = new Map<string, ApplicationInitialUserMessageHandoffEntry>();
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
      pending.set(handoff.sessionKey, { ...handoff, pending: true });
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
    retire: (sessionKey, owner, runId) => {
      const handoff = pending.get(findKey(sessionKey) ?? "");
      if (handoff?.owner === owner && handoff.pendingRunId === runId) {
        // Retain image bytes for exact adoption, but never re-admit server-owned input.
        handoff.pending = false;
      }
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
