import type { AgentMessage } from "../../runtime/index.js";

/**
 * How many trailing messages are always re-cloned fresh instead of served from
 * the cache. Settled history entries are append-only, but the newest messages
 * can still be touched in place (streaming assistant updates, usage stamping),
 * so the tail must never be cached.
 */
const FRESH_TAIL_MESSAGES = 2;

/**
 * Deep-frozen clone per source message. WeakMap-keyed on the message object:
 * when the runner rebuilds the hook message array each iteration it reuses the
 * same settled message objects, so each history entry is cloned once per
 * process instead of once per hook event. Without this, per-iteration
 * llm_input observation cloned the FULL history every model iteration —
 * profiled live at ~7.7s of structuredClone in one tool-heavy dispatch
 * (3,500-message DM history × ~20 iterations), starving concurrent dispatches.
 */
const frozenCloneByMessage = new WeakMap<AgentMessage, AgentMessage>();

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/**
 * Gives hooks an isolated message snapshot they cannot mutate in-session.
 * Cached entries are deep-frozen so the same clone is safe to share across
 * hook events and handlers: isolation only ever needed to protect the session
 * from hook writes (per-event clones were discarded after each run, so no
 * working hook behavior can depend on mutating them).
 */
export function cloneHookMessages(messages: AgentMessage[]): AgentMessage[] {
  const freshFrom = Math.max(0, messages.length - FRESH_TAIL_MESSAGES);
  return messages.map((message, index) => {
    if (index >= freshFrom || !message || typeof message !== "object") {
      return structuredClone(message);
    }
    const cached = frozenCloneByMessage.get(message);
    if (cached) {
      return cached;
    }
    const clone = deepFreeze(structuredClone(message));
    frozenCloneByMessage.set(message, clone);
    return clone;
  });
}
