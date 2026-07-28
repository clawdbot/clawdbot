/** Canonical predicate for message-tool-owned visible replies. */

/**
 * True when the visible source reply must flow through the message tool, either
 * because the run forces it or because the delivery mode is message_tool_only.
 * Consumers use this to keep the message tool visible/preserved: hiding the only
 * reply path leaves the run mute. The mode is accepted as plain string because
 * harness callers carry it untyped; only "message_tool_only" is meaningful here.
 */
export function messageToolOwnsVisibleReply(params: {
  forceMessageTool?: boolean;
  sourceReplyDeliveryMode?: string;
}): boolean {
  return params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only";
}
