import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import {
  readMessageToolSourceReplyText,
  resolveMessageToolSourceReplyFinal,
} from "./embedded-agent-message-tool-source-reply.js";
import { extractMessagingToolSourceReplyPayload } from "./embedded-agent-messaging-extraction.js";
import type { MessagingToolSend } from "./embedded-agent-messaging.types.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";

/** Commit delivery evidence after the owning tool-completion handler validates the send. */
export function commitMessagingToolDeliveryEvidence(params: {
  ctx: ToolHandlerContext;
  toolCallId: string;
  toolName: string;
  startArgs: Record<string, unknown>;
  result: unknown;
  isMessagingSend: boolean;
  didDeliverMessagingResult: boolean;
  deliveredMessageToolSourceReply: boolean;
  deliveredCurrentSourceReply: boolean;
  messageText?: string;
  confirmedMessageTarget?: MessagingToolSend;
  committedMediaUrls: string[];
  hasRichContent: boolean;
}): void {
  const sourceReplyFinal = params.deliveredMessageToolSourceReply
    ? resolveMessageToolSourceReplyFinal(params.startArgs)
    : undefined;
  const sourceReplyPayload = params.isMessagingSend
    ? extractMessagingToolSourceReplyPayload(params.result)
    : undefined;
  params.ctx.state.pendingMessagingTexts.delete(params.toolCallId);
  params.ctx.state.pendingMessagingTargets.delete(params.toolCallId);
  params.ctx.state.pendingMessagingMediaUrls.delete(params.toolCallId);
  if (params.didDeliverMessagingResult && params.messageText) {
    params.ctx.state.messagingToolSentTexts.push(params.messageText);
    params.ctx.state.messagingToolSentTextsNormalized.push(
      normalizeTextForComparison(params.messageText),
    );
    params.ctx.log.debug(
      `Committed messaging text: tool=${params.toolName} len=${params.messageText.length}`,
    );
    params.ctx.trimMessagingToolSent();
  }
  if (params.didDeliverMessagingResult && params.confirmedMessageTarget) {
    params.ctx.state.messagingToolSentTargets.push({
      ...params.confirmedMessageTarget,
      ...(params.messageText ? { text: params.messageText } : {}),
      ...(params.committedMediaUrls.length > 0
        ? { mediaUrls: params.committedMediaUrls.slice() }
        : {}),
      ...(params.hasRichContent ? { hasRichContent: true as const } : {}),
      ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
    });
    params.ctx.trimMessagingToolSent();
  }
  if (params.deliveredCurrentSourceReply) {
    params.ctx.state.messageToolOnlySourceReplyDelivered = true;
    if (params.deliveredMessageToolSourceReply) {
      const sourceReplyText = readMessageToolSourceReplyText(params.startArgs);
      const normalizedSourceReplyText = sourceReplyText
        ? normalizeTextForComparison(sourceReplyText)
        : "";
      if (normalizedSourceReplyText) {
        params.ctx.state.currentSourceMessagingToolSentTextsNormalized.push(
          normalizedSourceReplyText,
        );
        params.ctx.trimMessagingToolSent();
      }
    }
    params.ctx.params.onDeliveredMessageToolOnlySourceReply?.();
  }
  if (
    params.didDeliverMessagingResult &&
    params.isMessagingSend &&
    params.committedMediaUrls.length > 0
  ) {
    params.ctx.state.messagingToolSentMediaUrls.push(...params.committedMediaUrls);
    params.ctx.trimMessagingToolSent();
  }
  if (
    sourceReplyPayload &&
    (params.didDeliverMessagingResult || sourceReplyPayload.hostFinalDeferred === true)
  ) {
    params.ctx.state.messagingToolSourceReplyPayloads.push({
      ...sourceReplyPayload,
      ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
    });
    params.ctx.trimMessagingToolSent();
  }
}
