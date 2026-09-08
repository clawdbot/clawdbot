import type { SystemEvent } from "../../infra/system-events.js";

const REPLY_SYSTEM_EVENT_CONTEXT = Symbol("openclaw.reply.systemEventContext");

type ReplySystemEventContext = {
  sessionKey: string;
  events?: readonly SystemEvent[];
};

/** Carry the queue and its optional prepared selection through internal option spreads. */
export function withReplySystemEventContext<T extends object>(
  options: T,
  context: ReplySystemEventContext,
): T {
  return { ...options, [REPLY_SYSTEM_EVENT_CONTEXT]: context };
}

/** An absent selection means an ordinary turn may inspect the current queue. */
export function getReplySystemEventContext(
  options: object | undefined,
): ReplySystemEventContext | undefined {
  // SAFETY: only this module-private symbol and its typed producer establish the value.
  return (options as { [REPLY_SYSTEM_EVENT_CONTEXT]?: ReplySystemEventContext } | undefined)?.[
    REPLY_SYSTEM_EVENT_CONTEXT
  ];
}
