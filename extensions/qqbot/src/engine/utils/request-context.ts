/**
 * Request-level context using AsyncLocalStorage.
 *
 * Provides ambient context (accountId, target openid, chat type, etc.)
 * throughout the request lifecycle without explicit parameter threading.
 *
 * Gateway establishes the scope around each inbound message via
 * `runWithRequestContext()`; any async code within that scope (including
 * AI agent calls and tool `execute` callbacks) can retrieve the current
 * request via `getRequestContext()` without racing with concurrent
 * inbound messages.
 *
 * This is a pure Node.js module with zero framework dependencies,
 * making it trivially portable between the built-in and standalone
 * versions of QQBot.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Context values available during one inbound message handling cycle. */
interface RequestContext {
  /** The account ID handling this request. */
  accountId: string;
  /**
   * Fully qualified delivery target, e.g. `qqbot:c2c:<openid>` or
   * `qqbot:group:<openid>`. This is what downstream code (e.g. the
   * `qqbot_remind` tool building a cron job) uses verbatim.
   */
  target?: string;
  /** The target openid (C2C) or group openid (group). */
  targetId?: string;
  /** Chat type of the originating event. */
  chatType?: "c2c" | "group" | "guild" | "dm" | "channel";
}

const store = new AsyncLocalStorage<RequestContext>();

/**
 * Execute an async function with request-scoped context.
 *
 * All code running within `fn` (including nested async calls) can
 * retrieve the context via `getRequestContext()`.
 *
 * @param ctx - The context to attach to this request.
 * @param fn - The async function to run within the context.
 * @returns The return value of `fn`.
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/**
 * Retrieve the current request context.
 *
 * Returns `undefined` when called outside of a `runWithRequestContext`
 * scope.
 */
export function getRequestContext(): RequestContext | undefined {
  return store.getStore();
}
