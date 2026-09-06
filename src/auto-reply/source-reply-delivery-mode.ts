/** Visible-reply ownership and presentation guidance shared with agent harnesses. */
import { buildUiPresentationPrompt } from "../agents/ui-presentation-prompt.js";

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

export function buildHarnessVisibleReplyGuidance(params: {
  sourceReplyDeliveryMode?: string;
  messageToolAvailable: boolean;
  uiPresentation?: Parameters<typeof buildUiPresentationPrompt>[0];
}): string {
  const deliveryGuidance =
    messageToolOwnsVisibleReply(params) && params.messageToolAvailable
      ? "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. For progress, set `final=false`. Set `final=true`, or omit it, for the completed reply to the current source conversation; OpenClaw stops after confirming delivery. Do not repeat visible message content in your final answer."
      : params.messageToolAvailable
        ? "You can participate in the conversation throughout your work. Use `message` when you have something worth saying; you don’t need to wait until you’re finished, and sending a message doesn’t end your task. OpenClaw delivers your final response automatically."
        : "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation.";
  return [
    deliveryGuidance,
    params.uiPresentation ? buildUiPresentationPrompt(params.uiPresentation) : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}
