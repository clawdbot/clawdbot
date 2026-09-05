/** Routed delivery thread classification and id resolution helpers. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { MsgContext } from "../templating.js";

export function isSlackDirectRoutedThreadTurn(
  ctx: Pick<
    MsgContext,
    | "ChatType"
    | "MessageThreadId"
    | "OriginatingChannel"
    | "Provider"
    | "Surface"
    | "TransportThreadId"
  >,
): boolean {
  if (normalizeChatType(ctx.ChatType) !== "direct") {
    return false;
  }
  if (ctx.MessageThreadId == null && ctx.TransportThreadId == null) {
    return false;
  }
  return [ctx.Provider, ctx.Surface, ctx.OriginatingChannel].some(
    (value) => normalizeOptionalString(value)?.toLowerCase() === "slack",
  );
}

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
