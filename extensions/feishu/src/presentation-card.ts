// Feishu plugin module implements presentation card behavior.
import {
  normalizeMessagePresentation,
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationFallbackText,
  renderMessagePresentationTableFallbackText,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";

type NormalizedMessagePresentation = NonNullable<ReturnType<typeof normalizeMessagePresentation>>;

const FEISHU_CARD_MAX_BYTES = 30 * 1024;
const FEISHU_CARD_MAX_ELEMENTS = 200;

function countFeishuCardElements(value: unknown, ancestors = new Set<object>()): number {
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countFeishuCardElements(entry, ancestors), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (ancestors.has(value)) {
    return FEISHU_CARD_MAX_ELEMENTS + 1;
  }
  ancestors.add(value);
  const record = value as Record<string, unknown>;
  let count = typeof record.tag === "string" ? 1 : 0;
  for (const entry of Object.values(record)) {
    count += countFeishuCardElements(entry, ancestors);
    if (count > FEISHU_CARD_MAX_ELEMENTS) {
      break;
    }
  }
  ancestors.delete(value);
  return count;
}

export function isFeishuCardWithinEnvelope(card: Record<string, unknown>): boolean {
  try {
    return (
      Buffer.byteLength(JSON.stringify(card), "utf8") <= FEISHU_CARD_MAX_BYTES &&
      countFeishuCardElements(card) <= FEISHU_CARD_MAX_ELEMENTS
    );
  } catch {
    return false;
  }
}

export function assertFeishuCardWithinEnvelope(
  card: Record<string, unknown>,
  label = "Feishu card",
): void {
  if (!isFeishuCardWithinEnvelope(card)) {
    throw new Error(`${label} exceeds the 30 KB or 200-element API limit.`);
  }
}

/** Feishu allows at most 5 table components per static interactive card (ErrCode 11310). */
const FEISHU_CARD_TABLE_LIMIT = 5;

/**
 * Count GFM tables with the shared markdown parser (the same parser used for
 * post-mode table conversion), so every parser-recognized table form is caught
 * — including pipe-less GFM tables and alignment-colon delimiters — while
 * fenced code, thematic breaks, and plain pipes in prose are not counted.
 */
function countMarkdownTables(text: string): number {
  if (!text) {
    return 0;
  }
  return markdownToIRWithMeta(text, { tableMode: "block" }).tables.length;
}

/** Check whether the number of markdown tables is within Feishu static-card limits. */
export function withinCardTableLimit(text: string): boolean {
  return countMarkdownTables(text) <= FEISHU_CARD_TABLE_LIMIT;
}

function collectFeishuCardMarkdownTexts(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFeishuCardMarkdownTexts(item, out);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.tag === "markdown" && typeof record.content === "string") {
    out.push(record.content);
  }
  for (const child of Object.values(record)) {
    collectFeishuCardMarkdownTexts(child, out);
  }
}

/**
 * Check a built Feishu card JSON against the table limit by counting tables in
 * the combined markdown content of all its elements. Covers generated cards
 * whose tables come from fallback text as well as presentation blocks.
 */
export function feishuCardWithinTableLimit(card: Record<string, unknown>): boolean {
  const texts: string[] = [];
  collectFeishuCardMarkdownTexts(card, texts);
  const total = texts.reduce((sum, text) => sum + countMarkdownTables(text), 0);
  return total <= FEISHU_CARD_TABLE_LIMIT;
}

function escapeFeishuCardMarkdownText(text: string): string {
  return text.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return char;
    }
  });
}

function resolveSafeFeishuButtonUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function resolveFeishuButtonUrl(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "url" || button.action?.type === "web-app") {
    return button.action.url;
  }
  if (button.action) {
    return undefined;
  }
  return button.url ?? button.webApp?.url ?? button.web_app?.url;
}

function resolveFeishuCommandButtonValue(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "command") {
    return button.action.command;
  }
  if (button.action) {
    return undefined;
  }
  return button.value;
}

function mapFeishuButtonType(style: MessagePresentationButton["style"]) {
  if (style === "primary" || style === "success") {
    return "primary";
  }
  if (style === "danger") {
    return "danger";
  }
  return "default";
}

function buildFeishuPayloadButton(
  button: MessagePresentationButton,
): Record<string, unknown> | undefined {
  const behaviors: Record<string, unknown>[] = [];
  const rendered: Record<string, unknown> = {
    tag: "button",
    text: {
      tag: "plain_text",
      content: button.label,
    },
    type: mapFeishuButtonType(button.style),
  };
  const url = resolveFeishuButtonUrl(button);
  if (url) {
    const safeUrl = resolveSafeFeishuButtonUrl(url);
    if (safeUrl) {
      behaviors.push({ type: "open_url", default_url: safeUrl });
    }
  }
  const value = resolveFeishuCommandButtonValue(button);
  if (value) {
    behaviors.push({
      type: "callback",
      value: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: "feishu.payload.button",
        q: value,
      }),
    });
  }
  if (behaviors.length === 0) {
    return undefined;
  }
  rendered.behaviors = behaviors;
  return rendered;
}

function buildFeishuCardElementsForBlock(
  block: MessagePresentationBlock,
): Record<string, unknown>[] {
  if (block.type === "text") {
    return [{ tag: "markdown", content: escapeFeishuCardMarkdownText(block.text) }];
  }
  if (block.type === "context") {
    return [
      {
        tag: "markdown",
        content: `<font color='grey'>${escapeFeishuCardMarkdownText(block.text)}</font>`,
      },
    ];
  }
  if (block.type === "divider") {
    return [{ tag: "hr" }];
  }
  if (block.type === "buttons") {
    return block.buttons
      .map((button) => buildFeishuPayloadButton(button))
      .filter((button): button is Record<string, unknown> => Boolean(button));
  }
  if (block.type === "chart") {
    return [
      {
        tag: "markdown",
        content: escapeFeishuCardMarkdownText(renderMessagePresentationChartFallbackText(block)),
      },
    ];
  }
  if (block.type === "table") {
    return [
      {
        tag: "markdown",
        content: escapeFeishuCardMarkdownText(renderMessagePresentationTableFallbackText(block)),
      },
    ];
  }
  const labels = block.options.map((option) => `- ${option.label}`).join("\n");
  return [
    {
      tag: "markdown",
      content: `${escapeFeishuCardMarkdownText(
        block.placeholder?.trim() || "Options",
      )}:\n${escapeFeishuCardMarkdownText(labels)}`,
    },
  ];
}

function resolvePresentationHeaderTemplate(tone: NormalizedMessagePresentation["tone"]) {
  if (tone === "danger") {
    return "red";
  }
  if (tone === "warning") {
    return "orange";
  }
  if (tone === "success") {
    return "green";
  }
  return "blue";
}

export function buildFeishuPresentationCardElements(params: {
  presentation: NormalizedMessagePresentation;
  fallbackText?: string;
}): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const fallbackText = params.fallbackText?.trim();
  if (fallbackText) {
    elements.push({
      tag: "markdown",
      content: escapeFeishuCardMarkdownText(fallbackText),
    });
  }
  for (const block of params.presentation.blocks) {
    for (const element of buildFeishuCardElementsForBlock(block)) {
      elements.push(element);
    }
  }
  if (elements.length > 0) {
    return elements;
  }
  return [
    {
      tag: "markdown",
      content: renderMessagePresentationFallbackText({
        text: params.fallbackText,
        presentation: params.presentation.title
          ? {
              ...(params.presentation.tone ? { tone: params.presentation.tone } : {}),
              blocks: params.presentation.blocks,
            }
          : params.presentation,
      }),
    },
  ];
}

export function buildFeishuPresentationCard(params: {
  presentation: NormalizedMessagePresentation;
  fallbackText?: string;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    ...(params.presentation.title
      ? {
          header: {
            title: { tag: "plain_text", content: params.presentation.title },
            template: resolvePresentationHeaderTemplate(params.presentation.tone),
          },
        }
      : {}),
    body: {
      elements: buildFeishuPresentationCardElements(params),
    },
  };
}
