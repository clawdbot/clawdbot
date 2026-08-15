const REPLY_SYSTEM_EVENT_SESSION_KEY = Symbol("openclaw.reply.systemEventSessionKey");

/** Attach route-owned system-event state without widening public reply option contracts. */
export function withReplySystemEventSessionKey<T extends object>(
  options: T,
  sessionKey: string,
): T {
  return {
    ...options,
    [REPLY_SYSTEM_EVENT_SESSION_KEY]: sessionKey,
  };
}

/** Read route-owned system-event state after it crosses internal reply-option spreads. */
export function getReplySystemEventSessionKey(options: object | undefined): string | undefined {
  if (!options) {
    return undefined;
  }
  const value = (options as Record<PropertyKey, unknown>)[REPLY_SYSTEM_EVENT_SESSION_KEY];
  return typeof value === "string" ? value : undefined;
}
