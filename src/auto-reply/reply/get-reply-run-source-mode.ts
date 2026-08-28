import type { TemplateContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply-run.types.js";
import { isInternalSourceReplyChannel } from "./source-reply-delivery-mode.js";

/**
 * Resolves the turn's effective source-reply mode and surfaces dispatch's
 * injected session-stable mode separately, so the caller owns the synthetic
 * fallback in one place instead of un-mixing the two afterwards.
 */
export function resolvePromptSourceReplyMode(params: {
  promptSessionCtx: TemplateContext;
  opts?: InternalGetReplyOptions;
}) {
  const isInternalPromptChannel = isInternalSourceReplyChannel(params.promptSessionCtx);
  const sourceReplyDeliveryMode =
    params.promptSessionCtx.InboundEventKind === "room_event" && !isInternalPromptChannel
      ? "message_tool_only"
      : isInternalPromptChannel && params.opts?.sourceReplyDeliveryMode === undefined
        ? "automatic"
        : params.opts?.sourceReplyDeliveryMode;
  return {
    sourceReplyDeliveryMode,
    injectedSessionStableMode: params.opts?.sessionPromptSourceReplyDeliveryMode,
  };
}
