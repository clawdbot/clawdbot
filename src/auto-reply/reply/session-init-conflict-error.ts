// Lightweight identity and classification for the reply-session-init conflict
// error class. Kept side-effect free (no logging, no backoff) so it stays
// cheap to import from any caller, including shared runtime surfaces that
// the plugin SDK facade re-exports.
//
// The retry helper in `session-init-conflict-retry.ts` depends on this
// module; this module does not depend on it. `error-runtime` (a plugin-sdk
// facade) also depends on this module. Both consumers import the predicate
// (or class) from one source of truth.
//
// We delegate the cause/.error chain walk to the shared
// `collectErrorGraphCandidates` helper from `src/infra/errors.ts` instead of
// re-implementing BFS + cycle detection here. The traversal callback below
// is the only thing that is custom: it must stay side-effect free and must
// never throw, because callers (and the focused tests) feed arbitrary
// objects, including Proxies whose getters may raise. Throwing from inside
// the traversal would surface as a runtime crash at every channel entry
// point instead of a clean `false` reply.

import { collectErrorGraphCandidates } from "../../infra/errors.js";

const REPLY_SESSION_INIT_CONFLICT_MESSAGE_PATTERN =
  /^reply session initialization conflicted for \S+$/u;

/**
 * Raised when reply-session initialization loses its revision compare-and-swap.
 * The message shape is load-bearing for channel retry classification.
 */
export class ReplySessionInitConflictError extends Error {
  constructor(sessionKey: string) {
    super(`reply session initialization conflicted for ${sessionKey}`);
    this.name = "ReplySessionInitConflictError";
  }
}

/**
 * Safely read `cause` and `.error` from a node.  Uses direct access with
 * try/catch instead of `"key" in object` to avoid Proxy `has` traps.  The
 * return value is always a plain array — never throws.
 */
function safeReadCauseAndError(current: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  // Direct read with try/catch instead of `"key" in current` to avoid
  // triggering Proxy `has` traps.  A `has` trap that throws would surface
  // before the try/catch around the getter if we used the `in` operator.
  try {
    out.push(current.cause);
  } catch {
    // getter trap / has trap avoided via direct read; swallow.
  }
  try {
    out.push(current.error);
  } catch {
    // getter trap; swallow.
  }
  return out;
}

/**
 * Check `value instanceof ctor` without throwing.  Returns `false` when the
 * check itself raises (e.g. Proxy `getPrototypeOf` trap, revoked Proxy,
 * cross-realm Symbol.hasInstance).
 */
function safeInstanceof(value: unknown, ctor: new (...args: never[]) => unknown): boolean {
  try {
    return value instanceof ctor;
  } catch {
    return false;
  }
}

/**
 * Read the `message` property of an Error-like object without throwing.
 * Returns `undefined` when the getter raises.
 */
function safeErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    const msg = (value as { message?: unknown }).message;
    return typeof msg === "string" ? msg : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns whether an unknown value or its cause/error chain represents a
 * reply-session initialization conflict.
 *
 * Supports the typed error and the strictly matched legacy message format.
 * Does not rely on the error name or mutate the input.
 */
export function isReplySessionInitConflictError(error: unknown): boolean {
  const nested = collectErrorGraphCandidates(error, safeReadCauseAndError);

  for (const candidate of nested) {
    // 1) class instance — fastest path, covers all real throw-sites.
    if (safeInstanceof(candidate, ReplySessionInitConflictError)) {
      return true;
    }

    // 2) genuine Error instance — read .message via safe getter.
    if (safeInstanceof(candidate, Error)) {
      const msg = safeErrorMessage(candidate);
      if (msg !== undefined && REPLY_SESSION_INIT_CONFLICT_MESSAGE_PATTERN.test(msg)) {
        return true;
      }
      continue;
    }

    // 3) raw string — passed directly by callers that String(err) before.
    if (typeof candidate === "string") {
      if (REPLY_SESSION_INIT_CONFLICT_MESSAGE_PATTERN.test(candidate)) {
        return true;
      }
      // Not a valid object-message fallthrough — do not check .message here.
      continue;
    }

    // 4) Compatibility: old channel code paths (WhatsApp, Slack, Signal)
    //    passed arbitrary candidates through `formatErrorMessage`, which
    //    extracts `.message` from any object.  Replicate that here by
    //    checking for a `.message` property on non-Error objects.
    const msg = safeErrorMessage(candidate);
    if (msg !== undefined && REPLY_SESSION_INIT_CONFLICT_MESSAGE_PATTERN.test(msg)) {
      return true;
    }
  }

  return false;
}
