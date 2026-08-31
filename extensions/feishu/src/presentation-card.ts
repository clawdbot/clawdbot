// Feishu plugin module implements presentation card behavior.
import {
  legacyInteractiveReplyToPresentation,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationFallbackText,
  renderMessagePresentationTableFallbackText,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  escapeFeishuCardMarkdownText,
  escapeFeishuCardPlainText,
  resolveSafeFeishuButtonUrl,
} from "./native-card.js";

type NormalizedMessagePresentation = NonNullable<ReturnType<typeof normalizeMessagePresentation>>;
type FeishuPresentationTextFormat = "plain" | "markdown";

const FEISHU_CARD_MAX_BYTES = 30 * 1024;
const FEISHU_CARD_MAX_ELEMENTS = 200;

export function resolveFeishuRichReply(payload: { interactive?: unknown; presentation?: unknown }) {
  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  return {
    interactive,
    presentation:
      normalizeMessagePresentation(payload.presentation) ??
      (interactive ? legacyInteractiveReplyToPresentation(interactive) : undefined),
  };
}

export function buildFeishuPresentationFallback(params: {
  text?: string;
  presentation?: NormalizedMessagePresentation;
  fallbackHasCommand?: boolean;
  textFormat?: FeishuPresentationTextFormat;
}) {
  const fallbackText = renderFeishuPresentationFallbackText(params, params.textFormat);
  // Only warn when the rendered fallback exposes a command the user can copy.
  const fallbackHasCommand =
    params.fallbackHasCommand === true ||
    params.presentation?.blocks.some((block) =>
      block.type === "select"
        ? block.options.some(({ action }) => action?.type === "command")
        : block.type === "buttons" &&
          block.buttons.some(({ action, disabled }) => !disabled && action?.type === "command"),
    ) === true;
  return {
    fallbackText,
    fallbackHasCommand,
    commentText: fallbackHasCommand
      ? `${fallbackText}\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.`
      : fallbackText,
  };
}

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

export function renderFeishuPresentationFallbackText(
  params: Parameters<typeof renderMessagePresentationFallbackText>[0],
  textFormat: FeishuPresentationTextFormat = "plain",
): string {
  const presentation = params.presentation;
  return renderMessagePresentationFallbackText({
    ...params,
    presentation: presentation && {
      ...presentation,
      blocks: presentation.blocks.map((block) =>
        block.type === "buttons"
          ? {
              type: block.type,
              buttons: block.buttons.map((button) => {
                const url = resolveFeishuButtonUrl(button);
                // Reject the same targets everywhere; only Markdown transports escape labels.
                return {
                  ...button,
                  ...(textFormat === "markdown"
                    ? { label: escapeFeishuCardPlainText(button.label) }
                    : {}),
                  ...(url && !resolveSafeFeishuButtonUrl(url) ? { disabled: true } : {}),
                };
              }),
            }
          : block,
      ),
    },
  });
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

function buildFeishuPayloadButton(button: MessagePresentationButton): Record<string, unknown> {
  const url = resolveSafeFeishuButtonUrl(resolveFeishuButtonUrl(button));
  const value = resolveFeishuCommandButtonValue(button);
  if (button.disabled || (!url && !value)) {
    // Keep each unavailable control visible without exposing rejected URLs or opaque values.
    return { tag: "markdown", content: `- ${escapeFeishuCardPlainText(button.label)}` };
  }
  const behaviors: Record<string, unknown>[] = [];
  if (url) {
    behaviors.push({ type: "open_url", default_url: url });
  }
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
  return {
    tag: "button",
    text: { tag: "plain_text", content: button.label },
    type: mapFeishuButtonType(button.style),
    behaviors,
  };
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
    return block.buttons.map(buildFeishuPayloadButton);
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
  return [
    {
      tag: "markdown",
      content: escapeFeishuCardMarkdownText(
        renderMessagePresentationFallbackText({ presentation: { blocks: [block] } }),
      ),
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
  return [{ tag: "markdown", content: "" }];
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
