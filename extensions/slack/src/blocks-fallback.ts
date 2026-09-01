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
import { renderSlackRichTextFragments } from "./rich-text.js";

type SlackNativeDataFallbackFormat = "plain" | "mrkdwn-safe";

type RenderSlackBlockFallbackOptions = {
  nativeDataFormat?: SlackNativeDataFallbackFormat;
  nativeReferenceFormat?: SlackNativeDataFallbackFormat;
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
  const text = normalizeOptionalString(record?.text);
  if (!text) {
    return undefined;
  }
  return record?.type === "plain_text" && options.nativeDataFormat !== "plain"
    ? escapeSlackMrkdwn(text)
    : text;
}

function readContextTextFragments(
  block: Record<string, unknown>,
  options: RenderSlackBlockFallbackOptions = {},
): string[] {
  if (!Array.isArray(block.elements)) {
    return [];
  }
  return block.elements
    .map((element) => {
      const record = asOptionalRecord(element);
      const altText = normalizeOptionalString(record?.alt_text);
      return readTextObject(record, options) ?? (altText ? escapeSlackMrkdwn(altText) : undefined);
    })
    .filter((part): part is string => Boolean(part));
}

function readControlElementText(
  value: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const element = asOptionalRecord(value);
  const type = normalizeOptionalString(element?.type);
  if (type === "button" || type === "workflow_button") {
    return normalizeOptionalString(element?.text) ?? readTextObject(element?.text, options);
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

function readSectionTextFragments(
  block: Record<string, unknown>,
  options: RenderSlackBlockFallbackOptions = {},
): string[] {
  const parts = [readTextObject(block.text, options)];
  if (Array.isArray(block.fields)) {
    parts.push(...block.fields.map((field) => readTextObject(field, options)));
  }
  parts.push(readControlElementText(block.accessory, options));
  return parts.filter((part): part is string => Boolean(part));
}

/** Read only user-visible text from one Slack block. */
export function renderSlackBlockFallbackText(
  raw: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const block = asOptionalRecord(raw);
  if (!block) {
    return undefined;
  }
  switch (block.type) {
    case "rich_text":
      // Inbound references must survive for name resolution; literal text stays escaped
      // so token-shaped text cannot become a native mention. Outbound remains escaped.
      return normalizeOptionalString(
        renderSlackRichTextFragments(block.elements, {
          format: "escaped",
          preserveReferences: options.nativeReferenceFormat === "plain",
        }).join("\n"),
      );
    case "header":
      return readTextObject(block.text, options);
    case "section":
      return readSectionTextFragments(block, options).join("\n") || undefined;
    case "image": {
      const altText = normalizeOptionalString(block.alt_text);
      return (
        (altText ? escapeSlackMrkdwn(altText) : readTextObject(block.title)) ?? "Shared an image"
      );
    }
    case "video": {
      const altText = normalizeOptionalString(block.alt_text);
      return (
        readTextObject(block.title, options) ??
        (altText ? escapeSlackMrkdwn(altText) : "Shared a video")
      );
    }
    case "file":
      return "Shared a file";
    case "context":
      return readContextTextFragments(block, options).join(" ") || undefined;
    case "actions":
      return Array.isArray(block.elements)
        ? readControlElementsText(block.elements, options)
        : undefined;
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

// Each Slack text object owns its formatting; accessibility joins cannot prove equivalence.
export function renderSlackBlockTextFragments(raw: unknown): (string | null)[] {
  const block = asOptionalRecord(raw);
  if (block?.type === "context") {
    return readContextTextFragments(block);
  }
  if (block?.type === "section") {
    return readSectionTextFragments(block);
  }
  if (block?.type === "rich_text") {
    return renderSlackRichTextFragments(block.elements, { format: "styled" });
  }
  const text = renderSlackBlockFallbackText(raw);
  return text ? [text] : [];
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
