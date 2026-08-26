import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { persistedMessageEntryId, type AssistantMessageExpansionState } from "../chat-thread.ts";

export type MessageReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

type DuplicateSuffix = {
  count: number;
  label: string;
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
    return t(
      parsed.length === 1 ? "chat.codeBlock.jsonArrayItem" : "chat.codeBlock.jsonArrayItems",
      { count: String(parsed.length) },
    );
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length <= 4) {
      return `{ ${keys.join(", ")} }`;
    }
    return t("chat.codeBlock.jsonObjectKeys", { count: String(keys.length) });
  }
  return t("chat.codeBlock.jsonBadge");
}

export type MessageActionDetails = {
  markdown?: string;
  messageId?: string;
  replyTarget?: MessageReplyTarget;
  shouldFetchFullMessage: boolean;
};

function resolveNormalizedMessageMarkdown(normalizedMessage: NormalizedMessage): string {
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

/** Keep internal oversized-history markers out of every user-visible text surface. */
export function resolveMessageDisplayMarkdown(
  message: unknown,
  normalizedMessage: NormalizedMessage,
): string {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  if (metadata?.truncated === true && metadata.reason === "oversized") {
    return t("chat.messages.tooLargeToDisplay");
  }
  const markdown = resolveNormalizedMessageMarkdown(normalizedMessage);
  return normalizeRoleForGrouping(normalizedMessage.role) === "assistant"
    ? stripThinkingTags(markdown).trim()
    : markdown.trim();
}

export function resolveMessageReplyText(message: unknown): string {
  const normalizedMessage = normalizeMessage(message);
  return resolveMessageDisplayMarkdown(message, normalizedMessage);
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
  const normalizedMessage = normalizeMessage(message);
  const role = normalizeRoleForGrouping(normalizedMessage.role);
  const previewMarkdown = resolveMessageDisplayMarkdown(message, normalizedMessage);
  // The Gateway records every display-cap truncation as __openclaw.truncated, so
  // that marker is the whole contract: sniffing the in-band sentinel would fetch
  // for any reply that merely contains the text. Assistant-only because the
  // expander renders loaded content for assistant rows alone.
  const shouldFetchFullMessage = Boolean(
    role === "assistant" &&
    canFetchFullMessage &&
    messageId &&
    !record.openclawMessageToolMirror &&
    transcriptMeta?.truncated === true,
  );
  const expansion =
    role === "assistant" && shouldFetchFullMessage && messageId
      ? params.getAssistantMessageExpansion?.(messageId)
      : undefined;
  const visibleMarkdown =
    expansion?.status === "loaded" ? stripThinkingTags(expansion.markdown).trim() : previewMarkdown;
  const markdown = role === "assistant" ? visibleMarkdown : undefined;
  const replyText = onReply ? truncateUtf16Safe(visibleMarkdown, 500) : "";
  if (!markdown && !replyText && !(role === "assistant" && shouldFetchFullMessage)) {
    return null;
  }
  const sourceMessageId = persistedMessageEntryId(message);
  return {
    ...(markdown === undefined ? {} : { markdown }),
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
    shouldFetchFullMessage,
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

// Character length owns normal disclosure; this high line cap only bounds newline-heavy prompts.
const USER_MESSAGE_COLLAPSED_CHAR_LIMIT = 1_200;
const USER_MESSAGE_COLLAPSED_LINE_LIMIT = 40;

function shouldCollapseUserMessage(markdown: string): boolean {
  return (
    markdown.length > USER_MESSAGE_COLLAPSED_CHAR_LIMIT ||
    markdown.split("\n", USER_MESSAGE_COLLAPSED_LINE_LIMIT + 1).length >
      USER_MESSAGE_COLLAPSED_LINE_LIMIT
  );
}

function userMessageOverflowRef(expanded: boolean) {
  let resizeObserver: ResizeObserver | null = null;
  return (element: Element | undefined) => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const update = () => {
      const disclosure = element.parentElement;
      const toggle = disclosure?.querySelector<HTMLButtonElement>(
        ":scope > .chat-message-disclosure__toggle",
      );
      if (!disclosure || !toggle) {
        return;
      }
      const overflowing = expanded || element.scrollHeight > element.clientHeight + 1;
      disclosure.classList.toggle("has-overflow", overflowing);
      toggle.hidden = !overflowing;
    };
    // Lit resolves refs while siblings are still committing. Measure after the
    // toggle exists so wrapped text can reveal its own disclosure control.
    queueMicrotask(update);
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(element);
    }
  };
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
  duplicateSuffix?: DuplicateSuffix,
) {
  if (!opts.onToggleUserMessageExpanded || !shouldCollapseUserMessage(markdown)) {
    return renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions, duplicateSuffix);
  }

  const disclosureId = `user-message:${messageKey}`;
  const expanded = opts.isUserMessageExpanded?.(disclosureId) ?? false;
  return html`
    <div class="chat-message-disclosure ${expanded ? "is-expanded has-overflow" : ""}">
      <div class="chat-message-disclosure__content" ${ref(userMessageOverflowRef(expanded))}>
        ${renderMarkdownText(markdown, opts.isStreaming, markdownRenderOptions, duplicateSuffix)}
      </div>
      <button
        class="chat-message-disclosure__toggle"
        type="button"
        ?hidden=${!expanded}
        aria-label=${t(expanded ? "chat.messages.showLess" : "chat.messages.showMore")}
        aria-expanded=${String(expanded)}
        @click=${() => opts.onToggleUserMessageExpanded?.(disclosureId)}
      >
        ${expanded ? icons.chevronUp : icons.chevronDown}
      </button>
    </div>
  `;
}

export type AssistantMessageDisclosure = {
  expanded: boolean;
  markdown?: string;
  /** Set when automatic full-message retries exhausted; invoking re-enters the loader. */
  onRetryFullMessage?: () => void;
};

export function renderAssistantMessageMarkdown(
  previewMarkdown: string,
  isStreaming: boolean,
  disclosure: AssistantMessageDisclosure | undefined,
  markdownRenderOptions: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
  streamKey?: string,
) {
  const markdown = disclosure?.expanded
    ? (disclosure.markdown ?? previewMarkdown)
    : previewMarkdown;
  const renderOptions = disclosure?.expanded
    ? { ...markdownRenderOptions, mode: "document" as const }
    : markdownRenderOptions;
  const text = renderMarkdownText(markdown, isStreaming, renderOptions, duplicateSuffix, streamKey);
  if (!disclosure?.onRetryFullMessage) {
    return text;
  }
  // Exhausted automatic retries must not leave a silent truncated preview:
  // name the failure and offer a manual re-entry into the loader.
  return html`
    ${text}
    <div class="chat-message-load-error">
      ${t("chat.messages.fullContentLoadExhausted")}
      <button
        type="button"
        class="chat-message-load-error__retry"
        @click=${disclosure.onRetryFullMessage}
      >
        ${t("common.retry")}
      </button>
    </div>
  `;
}

export function renderMarkdownText(
  markdown: string,
  isStreaming: boolean,
  markdownRenderOptions?: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
  streamKey?: string,
) {
  const rendered = isStreaming
    ? toStreamingMarkdownHtml(markdown, markdownRenderOptions, streamKey)
    : toSanitizedMarkdownHtml(markdown, markdownRenderOptions);
  const content = duplicateSuffix ? appendDuplicateSuffix(rendered, duplicateSuffix) : rendered;
  return html`
    <div class="chat-text" dir="${detectTextDirection(markdown)}">${unsafeHTML(content)}</div>
  `;
}

function appendDuplicateSuffix(rendered: string, suffix: DuplicateSuffix): string {
  const template = document.createElement("template");
  template.innerHTML = rendered;
  const terminalBlock = template.content.lastElementChild;
  const target = terminalBlock ? duplicateSuffixTextOwner(terminalBlock) : null;

  const badge = document.createElement("span");
  badge.className = "chat-duplicate-count";
  badge.setAttribute("aria-label", suffix.label);
  badge.textContent = `×${suffix.count}`;
  (target ?? template.content).append(document.createTextNode("\u00a0"), badge);
  return template.innerHTML;
}

function duplicateSuffixTextOwner(block: Element): Element | null {
  if (/^(?:P|H[1-6])$/u.test(block.tagName)) {
    return block;
  }
  if (!/^(?:BLOCKQUOTE|LI|OL|UL)$/u.test(block.tagName)) {
    // Fences, details, raw blocks, and table shells own interactive or copied
    // content. Keep the status marker after the whole terminal block.
    return null;
  }
  const terminalChild = block.lastElementChild;
  if (!terminalChild) {
    return block.textContent?.trim() ? block : null;
  }
  return duplicateSuffixTextOwner(terminalChild);
}
