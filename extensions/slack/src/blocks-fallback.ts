// Slack plugin module implements blocks fallback behavior.
import {
  renderSlackDataTableFallbackText,
  renderSlackDataTableMrkdwnFallbackText,
  renderSlackTableFallbackText,
  renderSlackTableMrkdwnFallbackText,
} from "./data-table.js";
import {
  renderSlackDataVisualizationFallbackText,
  renderSlackDataVisualizationMrkdwnFallbackText,
} from "./data-visualization.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

type SlackNativeDataFallbackFormat = "plain" | "mrkdwn-safe";

type RenderSlackBlockFallbackOptions = {
  nativeDataFormat?: SlackNativeDataFallbackFormat;
};

type SlackBlockLike = {
  type?: unknown;
  text?: unknown;
  title?: unknown;
  alt_text?: unknown;
  elements?: unknown;
  fields?: unknown;
  accessory?: unknown;
};

type SlackRichTextElement = {
  type?: unknown;
  text?: unknown;
  url?: unknown;
  user_id?: unknown;
  channel_id?: unknown;
  usergroup_id?: unknown;
  name?: unknown;
  range?: unknown;
  fallback?: unknown;
  elements?: unknown;
};

const SLACK_SELECT_ELEMENT_TYPES = new Set([
  "static_select",
  "multi_static_select",
  "external_select",
  "multi_external_select",
  "users_select",
  "multi_users_select",
  "conversations_select",
  "multi_conversations_select",
  "channels_select",
  "multi_channels_select",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readTextObject(
  value: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const text = readNonEmptyString(record?.text);
  if (!text) {
    return undefined;
  }
  return record.type === "plain_text" && options.nativeDataFormat !== "plain"
    ? escapeSlackMrkdwn(text)
    : text;
}

function readTextValue(
  value: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  return readNonEmptyString(value) ?? readTextObject(value, options);
}

function renderSlackRichTextLeaf(element: SlackRichTextElement): string {
  switch (element.type) {
    case "text":
      return typeof element.text === "string" ? escapeSlackMrkdwn(element.text) : "";
    case "link":
      return escapeSlackMrkdwn(
        readNonEmptyString(element.text) ?? readNonEmptyString(element.url) ?? "",
      );
    case "user": {
      const userId = readNonEmptyString(element.user_id);
      return userId ? escapeSlackMrkdwn(`<@${userId}>`) : "";
    }
    case "channel": {
      const channelId = readNonEmptyString(element.channel_id);
      return channelId ? escapeSlackMrkdwn(`<#${channelId}>`) : "";
    }
    case "usergroup": {
      const usergroupId = readNonEmptyString(element.usergroup_id);
      return usergroupId ? escapeSlackMrkdwn(`<!subteam^${usergroupId}>`) : "";
    }
    case "broadcast": {
      const range = readNonEmptyString(element.range);
      return range ? escapeSlackMrkdwn(`<!${range}>`) : "";
    }
    case "emoji": {
      const name = readNonEmptyString(element.name);
      return name ? `:${name}:` : "";
    }
    case "date":
      return escapeSlackMrkdwn(readNonEmptyString(element.fallback) ?? "");
    default:
      return "";
  }
}

function renderSlackRichTextElement(value: unknown): string {
  const element = asRecord(value) as SlackRichTextElement | undefined;
  if (!element) {
    return "";
  }
  switch (element.type) {
    case "rich_text_section":
    case "rich_text_preformatted":
    case "rich_text_quote":
      return renderSlackRichTextElements(element.elements, "");
    case "rich_text_list":
      return renderSlackRichTextElements(element.elements, "\n");
    default:
      return renderSlackRichTextLeaf(element);
  }
}

function renderSlackRichTextElements(value: unknown, separator: string): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map(renderSlackRichTextElement).filter(Boolean).join(separator);
}

function readImageText(block: SlackBlockLike): string | undefined {
  const altText = readNonEmptyString(block.alt_text);
  return (altText ? escapeSlackMrkdwn(altText) : undefined) ?? readTextObject(block.title);
}

function readVideoText(
  block: SlackBlockLike,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const altText = readNonEmptyString(block.alt_text);
  return readTextObject(block.title, options) ?? (altText ? escapeSlackMrkdwn(altText) : undefined);
}

function readContextText(
  block: SlackBlockLike,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  if (!Array.isArray(block.elements)) {
    return undefined;
  }
  const parts = block.elements
    .map((element) => {
      const record = asRecord(element);
      const altText = readNonEmptyString(record?.alt_text);
      return readTextObject(record, options) ?? (altText ? escapeSlackMrkdwn(altText) : undefined);
    })
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function readControlElementText(
  value: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const element = asRecord(value);
  const type = readNonEmptyString(element?.type);
  if (type === "button" || type === "workflow_button") {
    return readTextValue(element?.text, options);
  }
  if (type && SLACK_SELECT_ELEMENT_TYPES.has(type)) {
    return readTextObject(element?.placeholder, options);
  }
  return undefined;
}

function readControlElementsText(
  values: readonly unknown[],
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const candidate = readControlElementText(value, options);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    labels.push(candidate);
  }
  return labels.length > 0 ? labels.join("\n") : undefined;
}

function readSectionText(
  block: SlackBlockLike,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const parts = [readTextObject(block.text, options)];
  if (Array.isArray(block.fields)) {
    parts.push(...block.fields.map((field) => readTextObject(field, options)));
  }
  parts.push(readControlElementText(block.accessory, options));
  const visibleParts = parts.filter((part): part is string => Boolean(part));
  return visibleParts.length > 0 ? visibleParts.join("\n") : undefined;
}

function readActionsText(
  block: SlackBlockLike,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  return Array.isArray(block.elements)
    ? readControlElementsText(block.elements, options)
    : undefined;
}

/** Read only user-visible text from one Slack block. */
export function renderSlackBlockFallbackText(
  raw: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const block = asRecord(raw) as SlackBlockLike | undefined;
  if (!block) {
    return undefined;
  }
  switch (block.type) {
    case "rich_text":
      return readNonEmptyString(renderSlackRichTextElements(block.elements, "\n"));
    case "header":
      return readTextObject(block.text, options);
    case "section":
      return readSectionText(block, options);
    case "image":
      return readImageText(block) ?? "Shared an image";
    case "video":
      return readVideoText(block, options) ?? "Shared a video";
    case "file":
      return "Shared a file";
    case "context":
      return readContextText(block, options);
    case "actions":
      return readActionsText(block, options);
    case "data_visualization":
      return options.nativeDataFormat === "plain"
        ? renderSlackDataVisualizationFallbackText(block)
        : renderSlackDataVisualizationMrkdwnFallbackText(block);
    case "data_table":
      return options.nativeDataFormat === "plain"
        ? renderSlackDataTableFallbackText(block)
        : renderSlackDataTableMrkdwnFallbackText(block);
    case "table":
      return options.nativeDataFormat === "plain"
        ? renderSlackTableFallbackText(block)
        : renderSlackTableMrkdwnFallbackText(block);
    default:
      return undefined;
  }
}

export function buildSlackBlocksFallbackText(blocks: readonly unknown[]): string {
  for (const block of blocks) {
    const text = renderSlackBlockFallbackText(block);
    if (text) {
      return text;
    }
  }

  return "Shared a Block Kit message";
}

export function buildSlackCompleteBlocksFallbackText(blocks: readonly unknown[]): string {
  const text = blocks
    .map((block) => renderSlackBlockFallbackText(block))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || buildSlackBlocksFallbackText(blocks);
}
