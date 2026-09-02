import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { NormalizedMessage } from "../../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";

// The new-session preview shares text presentation without loading transcript actions or tools.
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
export function detectJson(text: string): { parsed: unknown; text: string } | null {
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
      // Parsing is only for the summary; reserialization loses numeric precision and duplicate keys.
      return { parsed, text: trimmed };
    } catch {
      return null;
    }
  }
  return null;
}

/** Build a short summary label for collapsed JSON (type + key count or array length). */
function jsonSummaryLabel(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    return t(
      parsed.length === 1 ? "chat.codeBlock.jsonArrayItem" : "chat.codeBlock.jsonArrayItems",
      { count: String(parsed.length) },
    );
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    if (keys.length <= 4) {
      return `{ ${keys.join(", ")} }`;
    }
    return t("chat.codeBlock.jsonObjectKeys", { count: String(keys.length) });
  }
  return t("chat.codeBlock.jsonBadge");
}

export function renderMessageJson(
  result: NonNullable<ReturnType<typeof detectJson>>,
  open = false,
) {
  return html`<details class="chat-json-collapse" ?open=${open}>
    <summary class="chat-json-summary">
      <span class="chat-json-badge">${t("chat.codeBlock.jsonBadge")}</span>
      <span class="chat-json-label">${jsonSummaryLabel(result.parsed)}</span>
    </summary>
    <pre class="chat-json-content"><code>${result.text}</code></pre>
  </details>`;
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
  const markdown = normalizedMessage.content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
  return normalizeRoleForGrouping(normalizedMessage.role) === "assistant"
    ? stripThinkingTags(markdown).trim()
    : markdown.trim();
}

export function resolveMessageMarkdownRenderOptions(options: {
  role: string;
  isStreaming?: boolean;
  interactiveImages?: boolean;
  linkFavicons?: boolean;
}): MarkdownRenderOptions {
  return {
    assistantTranscriptRoleHeaders: options.role === "assistant",
    codeBlockChrome: options.role === "user" ? "none" : "copy",
    codeBlockInteraction: options.role === "assistant" ? "interactive" : "static",
    fileLinks: true,
    interactiveImages: Boolean(options.interactiveImages),
    sessionLinks: true,
    tableInteractions: "enabled",
    linkFavicons: Boolean(options.linkFavicons) && !options.isStreaming,
  };
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

export function renderMessageMarkdown(
  markdown: string,
  messageKey: string,
  opts: {
    role: string;
    isStreaming: boolean;
    isUserMessageExpanded?: (messageId: string) => boolean;
    onToggleUserMessageExpanded?: (messageId: string) => void;
    assistantMessageDisclosure?: AssistantMessageDisclosure;
  },
  markdownRenderOptions: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
) {
  const disclosure = opts.assistantMessageDisclosure;
  const isAssistant = opts.role === "assistant";
  const recoverFullMessage =
    isAssistant || (opts.role === "user" && disclosure?.onRetryFullMessage);
  const recovered = recoverFullMessage && disclosure?.expanded;
  const text = renderMarkdownText(
    recovered ? (disclosure.markdown ?? markdown) : markdown,
    opts.isStreaming,
    recovered ? { ...markdownRenderOptions, mode: "document" } : markdownRenderOptions,
    duplicateSuffix,
    isAssistant && opts.isStreaming ? messageKey : undefined,
  );
  // Exhausted recovery keeps the preview visible and offers manual re-entry.
  if (recoverFullMessage && disclosure?.onRetryFullMessage) {
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
  if (
    opts.role !== "user" ||
    !opts.onToggleUserMessageExpanded ||
    !shouldCollapseUserMessage(markdown)
  ) {
    return text;
  }

  const disclosureId = `user-message:${messageKey}`;
  const expanded = opts.isUserMessageExpanded?.(disclosureId) ?? false;
  return html`
    <div class="chat-message-disclosure ${expanded ? "is-expanded has-overflow" : ""}">
      <div class="chat-message-disclosure__content" ${ref(userMessageOverflowRef(expanded))}>
        ${text}
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

function renderMarkdownText(
  markdown: string,
  isStreaming: boolean,
  markdownRenderOptions?: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
  streamKey?: string,
) {
  const parts: [string, string] = isStreaming
    ? toStreamingMarkdownParts(markdown, markdownRenderOptions, streamKey)
    : [toSanitizedMarkdownHtml(markdown, markdownRenderOptions), ""];
  if (duplicateSuffix) {
    const terminalPart = parts[1].trim() ? 1 : 0;
    parts[terminalPart] = appendDuplicateSuffix(parts[terminalPart], duplicateSuffix);
  }
  // Separate Lit parts preserve completed code controls and diagrams while the
  // streaming tail changes; the Markdown splitter still owns container boundaries.
  const content = parts.map((part) => unsafeHTML(part));
  return html` <div class="chat-text" dir="${detectTextDirection(markdown)}">${content}</div> `;
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
