// Feishu plugin module implements presentation card behavior.
import {
  normalizeMessagePresentation,
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationFallbackText,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";

type NormalizedMessagePresentation = NonNullable<ReturnType<typeof normalizeMessagePresentation>>;

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
  return button.url ?? button.webApp?.url ?? button.web_app?.url;
}

function resolveFeishuCommandButtonValue(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "callback") {
    return undefined;
  }
  if (button.action?.type === "command") {
    return button.action.command;
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
