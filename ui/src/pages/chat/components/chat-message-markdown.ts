import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { persistedMessageEntryId, type AssistantMessageExpansionState } from "../chat-thread.ts";
import { extractMessageMediaText } from "./chat-message-media.ts";
import { resolveMessageDisplayMarkdown } from "./chat-message-text.ts";

export type MessageReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

export type MessageActionDetails = {
  markdown?: string;
  fullMessage?: { messageId: string; state: AssistantMessageExpansionState | undefined };
  replyTarget?: MessageReplyTarget;
};

// An explicit Markdown value is the displayed expansion, even when it is empty.
export function resolveMessageReplyText(
  message: unknown,
  normalizedMessage = normalizeMessage(message),
  markdown = resolveMessageDisplayMarkdown(message, normalizedMessage),
): string {
  return markdown || extractMessageMediaText(message, normalizedMessage.content);
}

export function resolveMessageActionDetails(params: {
  message: unknown;
  messageId: string;
  canFetchFullMessage?: boolean;
  getAssistantMessageExpansion?: (messageId: string) => AssistantMessageExpansionState | undefined;
  onReply?: (target: MessageReplyTarget) => void;
  senderLabel: string;
}): MessageActionDetails | null {
  const { message, messageId: renderMessageId, canFetchFullMessage, onReply, senderLabel } = params;
  const record = message as Record<string, unknown>;
  const transcriptMeta = asNullableRecord(record["__openclaw"]);
  const messageId =
    typeof transcriptMeta?.id === "string"
      ? transcriptMeta.id
      : typeof record.messageId === "string"
        ? record.messageId
        : undefined;
  const normalizedMessage = normalizeMessage(message);
  const role = normalizeRoleForGrouping(normalizedMessage.role);
  const pendingInput = messageId?.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX) === true;
  const previewMarkdown = resolveMessageDisplayMarkdown(message, normalizedMessage);
  // The Gateway records every display-cap truncation as __openclaw.truncated, so
  // that marker is the whole contract: sniffing the in-band sentinel would fetch
  // for any reply that merely contains the text. Pending user inputs share the
  // same read-only expansion, without becoming transcript reply/rewind targets.
  const fullMessage =
    (role === "assistant" || pendingInput) &&
    canFetchFullMessage &&
    messageId &&
    !record.openclawMessageToolMirror &&
    transcriptMeta?.truncated === true
      ? { messageId, state: params.getAssistantMessageExpansion?.(messageId) }
      : undefined;
  const expansion = fullMessage?.state;
  const expandedMarkdown = expansion?.status === "loaded" ? expansion.markdown : previewMarkdown;
  const visibleMarkdown =
    role === "assistant" ? stripThinkingTags(expandedMarkdown).trim() : expandedMarkdown;
  const markdown = role === "assistant" || pendingInput ? visibleMarkdown : undefined;
  const replyText =
    onReply && !pendingInput
      ? truncateUtf16Safe(resolveMessageReplyText(message, normalizedMessage, visibleMarkdown), 500)
      : "";
  if (!markdown && !replyText && !fullMessage) {
    return null;
  }
  const sourceMessageId = persistedMessageEntryId(message);
  return {
    ...(markdown === undefined ? {} : { markdown }),
    fullMessage,
    ...(replyText
      ? {
          replyTarget: {
            messageId: renderMessageId,
            text: replyText,
            senderLabel,
            ...(sourceMessageId ? { sourceMessageId } : {}),
          },
        }
      : {}),
  };
}

export function renderMessageActionButtons(
  details: MessageActionDetails,
  opts: {
    onReply?: (target: MessageReplyTarget) => void;
  },
) {
  return html`
    ${details.replyTarget && opts.onReply
      ? renderReplyButton(details.replyTarget, opts.onReply)
      : nothing}
    ${details.markdown ? renderCopyAsMarkdownButton(details.markdown) : nothing}
  `;
}

export function renderReplyButton(
  target: MessageReplyTarget,
  onReply: (target: MessageReplyTarget) => void,
) {
  return html`
    <openclaw-tooltip .content=${t("chat.messages.reply")}>
      <button
        class="chat-reply-btn"
        type="button"
        aria-label=${t("chat.messages.replyToMessage")}
        @click=${() => onReply(target)}
      >
        ${icons.messageSquare}
      </button>
    </openclaw-tooltip>
  `;
}
