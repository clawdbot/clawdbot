// Feishu native interactive card helpers shared by action and outbound delivery.
import {
  isRecord,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const FEISHU_CARD_TEMPLATES = new Set([
  "blue",
  "green",
  "red",
  "orange",
  "purple",
  "indigo",
  "wathet",
  "turquoise",
  "yellow",
  "grey",
  "carmine",
  "violet",
  "lime",
]);

export function resolveFeishuCardTemplate(template?: string): string | undefined {
  const normalized = normalizeOptionalLowercaseString(template);
  if (!normalized || !FEISHU_CARD_TEMPLATES.has(normalized)) {
    return undefined;
  }
  return normalized;
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

function escapeFeishuCardPlainText(text: string): string {
  return escapeFeishuCardMarkdownText(text).replace(/([\\`*_{}[\]()#+\-!|>~])/g, "\\$1");
}

function resolveSafeFeishuButtonUrl(url: unknown): string | undefined {
  const trimmed = typeof url === "string" ? url.trim() : "";
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

function sanitizeNativeFeishuButtonBehavior(
  behavior: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(behavior)) {
    return undefined;
  }
  if (behavior.type === "open_url") {
    const safeUrl =
      resolveSafeFeishuButtonUrl(behavior.default_url) ?? resolveSafeFeishuButtonUrl(behavior.url);
    return safeUrl ? { type: "open_url", default_url: safeUrl } : undefined;
  }
  if (behavior.type === "callback" && isRecord(behavior.value) && behavior.value.oc === "ocf1") {
    return { type: "callback", value: behavior.value };
  }
  return undefined;
}

function sanitizeNativeFeishuCardButton(button: unknown): Record<string, unknown> | undefined {
  if (!isRecord(button)) {
    return undefined;
  }
  const text =
    isRecord(button.text) && typeof button.text.content === "string"
      ? button.text.content
      : undefined;
  if (!text?.trim()) {
    return undefined;
  }
  const style =
    button.type === "danger"
      ? "danger"
      : button.type === "primary" || button.type === "success"
        ? "primary"
        : undefined;
  const behaviors = Array.isArray(button.behaviors)
    ? button.behaviors
        .map((behavior) => sanitizeNativeFeishuButtonBehavior(behavior))
        .filter((behavior): behavior is Record<string, unknown> => Boolean(behavior))
    : [];
  const rootSafeUrl = resolveSafeFeishuButtonUrl(button.url);
  if (rootSafeUrl) {
    behaviors.push({ type: "open_url", default_url: rootSafeUrl });
  }
  if (isRecord(button.value) && button.value.oc === "ocf1") {
    behaviors.push({ type: "callback", value: button.value });
  }
  if (behaviors.length === 0) {
    return undefined;
  }
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type: style === "danger" ? "danger" : style === "primary" ? "primary" : "default",
    behaviors,
  };
}

function sanitizeNativeFeishuCardElements(element: unknown): Record<string, unknown>[] {
  if (!isRecord(element) || typeof element.tag !== "string") {
    return [];
  }
  if (element.tag === "hr") {
    return [{ tag: "hr" }];
  }
  if (element.tag === "markdown" && typeof element.content === "string") {
    return [
      {
        tag: "markdown",
        content: escapeFeishuCardMarkdownText(element.content),
      },
    ];
  }
  if (element.tag === "div" && isRecord(element.text)) {
    const text = element.text;
    if (text.tag === "lark_md" && typeof text.content === "string") {
      return [
        {
          tag: "markdown",
          content: escapeFeishuCardMarkdownText(text.content),
        },
      ];
    }
    if (text.tag === "plain_text" && typeof text.content === "string") {
      return [
        {
          tag: "markdown",
          content: escapeFeishuCardPlainText(text.content),
        },
      ];
    }
    return [];
  }
  if (element.tag === "button") {
    const button = sanitizeNativeFeishuCardButton(element);
    return button ? [button] : [];
  }
  if (element.tag === "action" && Array.isArray(element.actions)) {
    return element.actions
      .map((action) => sanitizeNativeFeishuCardButton(action))
      .filter((action): action is Record<string, unknown> => Boolean(action));
  }
  return [];
}

export function sanitizeNativeFeishuCard(
  card: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const normalizedCard = card.type === "interactive" && isRecord(card.card) ? card.card : card;
  const body = isRecord(normalizedCard.body) ? normalizedCard.body : undefined;
  const rawElements = Array.isArray(body?.elements)
    ? body.elements
    : Array.isArray(normalizedCard.elements)
      ? normalizedCard.elements
      : [];
  const elements = rawElements
    .flatMap((element) => sanitizeNativeFeishuCardElements(element))
    .filter((element): element is Record<string, unknown> => Boolean(element));
  if (elements.length === 0) {
    return undefined;
  }

  const header = isRecord(normalizedCard.header) ? normalizedCard.header : undefined;
  const title =
    isRecord(header?.title) && typeof header.title.content === "string"
      ? header.title.content
      : undefined;
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    ...(title?.trim()
      ? {
          header: {
            title: { tag: "plain_text", content: title },
            template:
              resolveFeishuCardTemplate(
                typeof header?.template === "string" ? header.template : undefined,
              ) ?? "blue",
          },
        }
      : {}),
    body: { elements },
  };
}

export function readNativeFeishuCardJson(
  text: string | undefined,
  options?: { responsePrefix?: string },
): Record<string, unknown> | undefined {
  let trimmed = text?.trim();
  const responsePrefix = options?.responsePrefix;
  if (trimmed && responsePrefix && trimmed.startsWith(responsePrefix)) {
    const suffix = trimmed.slice(responsePrefix.length);
    // The runner inserts one separator before the original message. Requiring it
    // avoids treating arbitrary prose before a JSON object as a native card.
    if (/^\s+\{/.test(suffix)) {
      trimmed = suffix.trimStart();
    }
  }
  if (!trimmed?.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? sanitizeNativeFeishuCard(parsed) : undefined;
  } catch {
    return undefined;
  }
}
