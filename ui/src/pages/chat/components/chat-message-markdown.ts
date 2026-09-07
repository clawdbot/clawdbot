import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerBookmarksEnglish } from "../../../i18n/locales/en-bookmarks.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import type { ChatBookmarkAccess } from "../chat-bookmarks.ts";
import { persistedMessageEntryId, type AssistantMessageExpansionState } from "../chat-thread.ts";
import { extractMessageMediaText } from "./chat-message-media.ts";
import { resolveMessageDisplayMarkdown } from "./chat-message-text.ts";

registerBookmarksEnglish();

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
  bookmark?: { messageId: string; name?: string };
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
  bookmarkAccess?: ChatBookmarkAccess;
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
    role === "assistant" ? stripThinkingTags(expandedMarkdown) : expandedMarkdown;
  const markdown = role === "assistant" || pendingInput ? visibleMarkdown : undefined;
  const replyText =
    onReply && !pendingInput
      ? truncateUtf16Safe(resolveMessageReplyText(message, normalizedMessage, visibleMarkdown), 500)
      : "";
  const sourceMessageId = persistedMessageEntryId(message);
  const bookmark =
    sourceMessageId &&
    (role === "user" || role === "assistant") &&
    params.bookmarkAccess &&
    !record.openclawMessageToolMirror
      ? {
          messageId: sourceMessageId,
          name: params.bookmarkAccess.bookmarks.find((item) => item.messageId === sourceMessageId)
            ?.name,
        }
      : undefined;
  if (!markdown && !replyText && !fullMessage && !bookmark) {
    return null;
  }
  return {
    bookmark,
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
    bookmarkAccess?: ChatBookmarkAccess;
    rewindAction?: TemplateResult | typeof nothing;
  },
) {
  return html`
    ${renderBookmarkAction(details, opts.bookmarkAccess)}
    ${
      details.replyTarget && opts.onReply
        ? renderReplyButton(details.replyTarget, opts.onReply)
        : nothing
    }
    ${opts.rewindAction ?? nothing}
    ${details.markdown ? renderCopyAsMarkdownButton(details.markdown) : nothing}
    ${renderBookmarkName(details, opts.bookmarkAccess)}
  `;
}

function renderReplyButton(
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

function renderBookmarkAction(details: MessageActionDetails, access?: ChatBookmarkAccess) {
  const bookmark = details.bookmark;
  if (!bookmark || !access?.toggle) {
    return nothing;
  }
  const label = t(bookmark.name ? "chat.bookmarks.remove" : "chat.bookmarks.add");
  return html`<openclaw-tooltip .content=${label}>
    <button
      class="chat-reply-btn chat-bookmark-btn"
      type="button"
      aria-label=${label}
      aria-pressed=${Boolean(bookmark.name)}
      @click=${() => access.toggle?.(bookmark.messageId)}
    >
      ${icons.claw}
    </button>
  </openclaw-tooltip>`;
}

function renderBookmarkName(details: MessageActionDetails, access?: ChatBookmarkAccess) {
  const bookmark = details.bookmark;
  if (!bookmark?.name) {
    return nothing;
  }
  return access?.edit
    ? html`<button
        class="chat-bookmark-name"
        type="button"
        title=${t("chat.bookmarks.rename")}
        @click=${() => access.edit?.(bookmark.messageId)}
      >
        ${bookmark.name}
      </button>`
    : html`<span class="chat-bookmark-name">${bookmark.name}</span>`;
}
