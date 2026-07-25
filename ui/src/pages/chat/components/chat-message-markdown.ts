import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { renderDeleteButton } from "./chat-message-confirmation.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

export type MessageReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

const MAX_JSON_AUTOPARSE_CHARS = 20_000;

/**
 * Detect whether a trimmed string is a JSON object or array.
 * Must start with `{`/`[` and end with `}`/`]` and parse successfully.
 * Size-capped to prevent render-loop DoS from large JSON messages.
 */
export function detectJson(text: string): { parsed: unknown; pretty: string } | null {
  const trimmed = text.trim();

  // Enforce size cap to prevent UI freeze from multi-MB JSON payloads
  if (trimmed.length > MAX_JSON_AUTOPARSE_CHARS) {
    return null;
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return { parsed, pretty: JSON.stringify(parsed, null, 2) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Build a short summary label for collapsed JSON (type + key count or array length). */
export function jsonSummaryLabel(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    return `Array (${parsed.length} item${parsed.length === 1 ? "" : "s"})`;
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length <= 4) {
      return `{ ${keys.join(", ")} }`;
    }
    return `Object (${keys.length} keys)`;
  }
  return "JSON";
}

function renderExpandButton(
  markdown: string,
  onOpenSidebar: (content: SidebarContent) => void,
  options?: {
    sessionKey?: string;
    agentId?: string;
    messageId?: string;
  },
) {
  return html`
    <openclaw-tooltip .content=${t("chat.messages.openInCanvas")}>
      <button
        class="chat-expand-btn"
        type="button"
        aria-label=${t("chat.messages.openInCanvas")}
        @click=${() =>
          onOpenSidebar({
            kind: "markdown",
            content: markdown,
            ...(options?.sessionKey && options?.messageId
              ? {
                  fullMessageRequest: {
                    sessionKey: options.sessionKey,
                    ...(options.agentId ? { agentId: options.agentId } : {}),
                    messageId: options.messageId,
                    kind: "assistant_message" as const,
                  },
                }
              : {}),
          })}
      >
        <span class="chat-expand-btn__icon" aria-hidden="true">${icons.panelRightOpen}</span>
      </button>
    </openclaw-tooltip>
  `;
}

type MessageActionDetails = {
  markdown?: string;
  messageId?: string;
  replyTarget?: MessageReplyTarget;
  shouldFetchFullMessage: boolean;
};

export function resolveNormalizedMessageMarkdown(normalizedMessage: NormalizedMessage): string {
  return normalizedMessage.content
    .reduce<string[]>((lines, item) => {
      if (item.type === "text" && typeof item.text === "string") {
        lines.push(item.text);
      }
      return lines;
    }, [])
    .join("\n")
    .trim();
}

export function resolveMessageActionDetails(params: {
  message: unknown;
  messageId: string;
  onOpenSidebar?: (content: SidebarContent) => void;
  onReply?: (target: MessageReplyTarget) => void;
  senderLabel: string;
}): MessageActionDetails | null {
  const { message, messageId: renderMessageId, onOpenSidebar, onReply, senderLabel } = params;
  const record = message as Record<string, unknown>;
  const normalizedMessage = normalizeMessage(message);
  const normalizedMarkdown = resolveNormalizedMessageMarkdown(normalizedMessage);
  const role = normalizeRoleForGrouping(normalizedMessage.role);
  const visibleMarkdown =
    role === "assistant" ? stripThinkingTags(normalizedMarkdown).trim() : normalizedMarkdown.trim();
  const markdown = role === "assistant" ? visibleMarkdown : undefined;
  const replyText = onReply ? truncateUtf16Safe(visibleMarkdown, 500) : "";
  if (!markdown && !replyText) {
    return null;
  }
  const transcriptMeta =
    record["__openclaw"] &&
    typeof record["__openclaw"] === "object" &&
    !Array.isArray(record["__openclaw"])
      ? (record["__openclaw"] as Record<string, unknown>)
      : null;
  const messageId =
    typeof transcriptMeta?.id === "string"
      ? transcriptMeta.id
      : typeof record.messageId === "string"
        ? record.messageId
        : undefined;
  const sourceMessageId = persistedMessageEntryId(message);
  return {
    ...(markdown ? { markdown } : {}),
    messageId,
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
    shouldFetchFullMessage: Boolean(
      onOpenSidebar &&
      messageId &&
      !record.openclawMessageToolMirror &&
      (transcriptMeta?.truncated === true || markdown?.includes("\n...(truncated)...")),
    ),
  };
}

export function renderMessageActionButtons(
  details: MessageActionDetails,
  opts: {
    sessionKey?: string;
    agentId?: string;
    onReply?: (target: MessageReplyTarget) => void;
  },
  onOpenSidebar?: (content: SidebarContent) => void,
  onDelete?: () => void,
) {
  return html`
    ${details.replyTarget && opts.onReply
      ? renderReplyButton(details.replyTarget, opts.onReply)
      : nothing}
    ${onDelete ? renderDeleteButton(onDelete, "right") : nothing}
    ${details.markdown && onOpenSidebar
      ? renderExpandButton(details.markdown, onOpenSidebar, {
          sessionKey: opts.sessionKey,
          agentId: opts.agentId,
          messageId: details.shouldFetchFullMessage ? details.messageId : undefined,
        })
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

const USER_MESSAGE_COLLAPSED_LINE_LIMIT = 12;
const USER_MESSAGE_COLLAPSED_CHAR_LIMIT = 700;

function collapsedUserMessagePreview(markdown: string): string | null {
  let end = Math.min(markdown.length, USER_MESSAGE_COLLAPSED_CHAR_LIMIT);
  let lineCount = 1;
  for (let index = 0; index < end; index += 1) {
    if (markdown[index] !== "\n") {
      continue;
    }
    if (lineCount === USER_MESSAGE_COLLAPSED_LINE_LIMIT) {
      end = index;
      break;
    }
    lineCount += 1;
  }
  if (end === markdown.length) {
    return null;
  }
  const sliced = markdown.slice(0, end);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);
  const preview = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? sliced.slice(0, -1) : sliced;
  return `${preview.trimEnd()}…`;
}

export function renderUserMessageMarkdown(
  markdown: string,
  messageKey: string,
  opts: {
    isStreaming: boolean;
    isUserMessageExpanded?: (messageId: string) => boolean;
    onToggleUserMessageExpanded?: (messageId: string) => void;
  },
  markdownRenderOptions: MarkdownRenderOptions,
) {
  const preview = collapsedUserMessagePreview(markdown);
  if (!opts.onToggleUserMessageExpanded || preview === null) {
    return renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions);
  }

  const disclosureId = `user-message:${messageKey}`;
  const expanded = opts.isUserMessageExpanded?.(disclosureId) ?? false;
  return html`
    <div class="chat-user-message-disclosure ${expanded ? "is-expanded" : ""}">
      <div class="chat-user-message-disclosure__content">
        ${expanded
          ? renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions)
          : html`<div class="chat-user-message-disclosure__preview">${preview}</div>`}
      </div>
      <button
        class="chat-user-message-disclosure__toggle"
        type="button"
        aria-expanded=${String(expanded)}
        @click=${() => opts.onToggleUserMessageExpanded?.(disclosureId)}
      >
        ${t(expanded ? "chat.messages.showLess" : "chat.messages.showMore")}
      </button>
    </div>
  `;
}

export function renderMarkdownText(
  markdown: string,
  isStreaming: boolean,
  markdownRenderOptions?: MarkdownRenderOptions,
) {
  if (isStreaming) {
    return html`
      <div class="chat-text" dir="${detectTextDirection(markdown)}">
        ${unsafeHTML(toStreamingMarkdownHtml(markdown, markdownRenderOptions))}
      </div>
    `;
  }
  return html`
    <div class="chat-text" dir="${detectTextDirection(markdown)}">
      ${unsafeHTML(toSanitizedMarkdownHtml(markdown, markdownRenderOptions))}
    </div>
  `;
}
