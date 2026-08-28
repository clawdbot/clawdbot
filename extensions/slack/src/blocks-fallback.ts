// Slack plugin module implements blocks fallback behavior.
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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
  nativeReferenceFormat?: SlackNativeDataFallbackFormat;
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

function readTextObject(
  value: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const record = asOptionalRecord(value);
  if (!record) {
    return undefined;
  }
  const text = normalizeOptionalString(record?.text);
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
  return normalizeOptionalString(value) ?? readTextObject(value, options);
}

function renderSlackRichTextElement(
  value: unknown,
  renderReference: (text: string) => string,
): string {
  const element = asOptionalRecord(value) as SlackRichTextElement | undefined;
  if (!element) {
    return "";
  }
  switch (element.type) {
    case "rich_text_section":
    case "rich_text_preformatted":
    case "rich_text_quote":
      return renderSlackRichTextElements(element.elements, "", renderReference);
    case "rich_text_list":
      return renderSlackRichTextElements(element.elements, "\n", renderReference);
    case "text":
      return typeof element.text === "string" ? escapeSlackMrkdwn(element.text) : "";
    case "link":
      return escapeSlackMrkdwn(
        normalizeOptionalString(element.text) ?? normalizeOptionalString(element.url) ?? "",
      );
    case "user": {
      const userId = normalizeOptionalString(element.user_id);
      return userId ? renderReference(`<@${userId}>`) : "";
    }
    case "channel": {
      const channelId = normalizeOptionalString(element.channel_id);
      return channelId ? renderReference(`<#${channelId}>`) : "";
    }
    case "usergroup": {
      const usergroupId = normalizeOptionalString(element.usergroup_id);
      return usergroupId ? renderReference(`<!subteam^${usergroupId}>`) : "";
    }
    case "broadcast": {
      const range = normalizeOptionalString(element.range);
      return range ? renderReference(`<!${range}>`) : "";
    }
    case "emoji": {
      const name = normalizeOptionalString(element.name);
      return name ? `:${name}:` : "";
    }
    case "date":
      return escapeSlackMrkdwn(normalizeOptionalString(element.fallback) ?? "");
    default:
      return "";
  }
}

function renderSlackRichTextElements(
  value: unknown,
  separator: string,
  renderReference: (text: string) => string,
): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((element) => renderSlackRichTextElement(element, renderReference))
    .filter(Boolean)
    .join(separator);
}

function readImageText(block: SlackBlockLike): string | undefined {
  const altText = normalizeOptionalString(block.alt_text);
  return (altText ? escapeSlackMrkdwn(altText) : undefined) ?? readTextObject(block.title);
}

function readVideoText(
  block: SlackBlockLike,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const altText = normalizeOptionalString(block.alt_text);
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
      const record = asOptionalRecord(element);
      const altText = normalizeOptionalString(record?.alt_text);
      return readTextObject(record, options) ?? (altText ? escapeSlackMrkdwn(altText) : undefined);
    })
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function readControlElementText(
  value: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const element = asOptionalRecord(value);
  const type = normalizeOptionalString(element?.type);
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
  const block = asOptionalRecord(raw) as SlackBlockLike | undefined;
  if (!block) {
    return undefined;
  }
  switch (block.type) {
    case "rich_text":
      // Inbound references must survive for name resolution; literal text stays escaped
      // so token-shaped text cannot become a native mention. Outbound remains escaped.
      return normalizeOptionalString(
        renderSlackRichTextElements(
          block.elements,
          "\n",
          options.nativeReferenceFormat === "plain" ? (text) => text : escapeSlackMrkdwn,
        ),
      );
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
