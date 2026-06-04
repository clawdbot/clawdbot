/** Resolves the thread id used when replies are routed through channel delivery helpers. */
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { MsgContext } from "../templating.js";

/** Prefers current inbound thread ids, falling back to persisted session thread metadata. */
export function resolveRoutedDeliveryThreadId(params: {
  ctx: MsgContext;
  sessionKey?: string;
}): string | number | undefined {
  if (params.ctx.MessageThreadId != null) {
    return params.ctx.MessageThreadId;
  }
  if (params.ctx.TransportThreadId != null) {
    return params.ctx.TransportThreadId;
  }
  return parseSessionThreadInfoFast(params.sessionKey).threadId;
}
