import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import type { ApplicationInitialUserMessageHandoff } from "./context.ts";

// Terminal history removes normal entries; this cap bounds abandoned active-session handoffs.
const MAX_PENDING_INITIAL_USER_MESSAGES = 32;

export function createInitialUserMessageHandoff(): ApplicationInitialUserMessageHandoff {
  const pending = new Map<
    string,
    Pick<Parameters<ApplicationInitialUserMessageHandoff["prepare"]>[0], "message" | "owner">
  >();
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
      pending.set(handoff.sessionKey, { message: handoff.message, owner: handoff.owner });
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
      return handoff && handoff.owner === owner ? handoff.message : null;
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
