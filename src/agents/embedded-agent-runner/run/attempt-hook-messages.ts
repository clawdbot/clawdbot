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
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  // Array-buffer views are opaque leaves: neither freezable nor worth walking.
  //
  // `Object.freeze` throws `TypeError: Cannot freeze array buffer views with
  // elements` for any non-empty typed array, because freezing demands every own
  // property become non-configurable and integer-indexed elements refuse that.
  // `CustomMessage.details` is typed `T = unknown`, so parking a `Uint8Array`
  // there is valid — and the throw surfaced in the `runLlmInput` argument list,
  // i.e. during argument evaluation, before any promise existed. The call site's
  // `.catch()` is attached to a promise that is never reached, so the TypeError
  // escaped synchronously and aborted the prompt phase before the model call.
  //
  // Recursing into a view is also ruinous: `Reflect.ownKeys` on a `Uint8Array`
  // materializes one string key per byte (100,000 keys for a 100 KB payload)
  // and would then recurse once per element — a pathological cost inside a
  // change whose whole purpose is to make this clone cheap.
  //
  // Binary payloads are therefore shared un-frozen across cached observations.
  // That is the pre-existing guarantee stated honestly rather than a new hole:
  // `Object.freeze` cannot make backing bytes read-only, so it never protected
  // view contents even when it did not throw.
  if (ArrayBuffer.isView(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen);
  }
  return Object.freeze(value);
}

/**
 * Gives the observational `llm_input` hook an isolated read-only snapshot.
 * Cached entries are deep-frozen so the same clone is safe to share across
 * repeated observations. Modifying hooks must continue to receive fresh,
 * writable clones instead of using this cache.
 */
export function cloneLlmInputHookMessages(messages: AgentMessage[]): AgentMessage[] {
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
