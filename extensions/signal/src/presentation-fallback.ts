// Signal plugin module materializes portable presentations into sendable text.
import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

/** Materialize presentation content once before Signal's text-only delivery funnels. */
export function materializeSignalPresentationFallback(
  payload: ReplyPayload,
  presentationOverride?: MessagePresentation,
): ReplyPayload {
  const presentation = presentationOverride ?? normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }

  const currentText = payload.text?.trim() ?? "";
  const approvalTextOwnsControls = Boolean(getExecApprovalReplyMetadata(payload) && currentText);
  // Structured approval text already enumerates every command. Rendering its
  // control blocks again would duplicate Allow/Deny guidance on text-only Signal.
  const fallbackPresentation = approvalTextOwnsControls
    ? {
        ...presentation,
        blocks: presentation.blocks.filter(
          (block) => !isMessagePresentationInteractiveBlock(block),
        ),
      }
    : presentation;
  const presentationFallback = renderMessagePresentationFallbackText({
    presentation: fallbackPresentation,
  });
  const text = currentText.includes(presentationFallback)
    ? currentText
    : [currentText, presentationFallback].filter(Boolean).join("\n\n");
  const { presentation: _presentation, ...withoutPresentation } = payload;
  return { ...withoutPresentation, text };
}
