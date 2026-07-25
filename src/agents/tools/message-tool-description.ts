import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";

const MESSAGE_TOOL_THREAD_READ_HINT = ' Missing thread context: action="read" + threadId.';

export function appendMessageToolVisibleReplyHint(
  description: string,
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode,
  requireExplicitTarget?: boolean,
): string {
  if (sourceReplyDeliveryMode !== "message_tool_only") {
    return description;
  }
  const targetGuidance = requireExplicitTarget
    ? "send needs target."
    : "target defaults current source; set only elsewhere.";
  return `${description} This turn visible reply: action="send" + message; ${targetGuidance} Final answer private.`;
}

export function appendMessageToolReadHint(
  description: string,
  actions: Iterable<ChannelMessageActionName | "send">,
): string {
  for (const action of actions) {
    if (action === "read") {
      return `${description}${MESSAGE_TOOL_THREAD_READ_HINT}`;
    }
  }
  return description;
}
