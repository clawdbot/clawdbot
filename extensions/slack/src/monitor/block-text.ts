import {
  normalizeOptionalString,
  readStringValue as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { renderSlackDataVisualizationFallbackText } from "../data-visualization.js";

type SlackTextObject = {
  text?: unknown;
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
  elements?: unknown;
};

type SlackBlockLike = {
  type?: unknown;
  text?: unknown;
  elements?: unknown;
  fields?: unknown;
  alt_text?: unknown;
  title?: unknown;
};

type SlackBlocksText = {
  text: string;
  hasRichText: boolean;
  hasDataVisualization: boolean;
};

function readTextObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString(readString((value as SlackTextObject).text));
}

function renderSlackRichTextLeaf(element: SlackRichTextElement): string {
  switch (element.type) {
    case "text":
      return readString(element.text) ?? "";
    case "link":
      return readString(element.text) ?? readString(element.url) ?? "";
    case "user": {
      const userId = readString(element.user_id);
      return userId ? `<@${userId}>` : "";
    }
    case "channel": {
      const channelId = readString(element.channel_id);
      return channelId ? `<#${channelId}>` : "";
    }
    case "usergroup": {
      const usergroupId = readString(element.usergroup_id);
      return usergroupId ? `<!subteam^${usergroupId}>` : "";
    }
    case "broadcast": {
      const range = readString(element.range);
      return range ? `<!${range}>` : "";
    }
    case "emoji": {
      const name = readString(element.name);
      return name ? `:${name}:` : "";
    }
    default:
      return "";
  }
}

function renderSlackRichTextElements(elements: unknown): string {
  if (!Array.isArray(elements)) {
    return "";
  }
  const parts: string[] = [];
  for (const rawElement of elements) {
    if (!rawElement || typeof rawElement !== "object") {
      continue;
    }
    const element = rawElement as SlackRichTextElement;
    switch (element.type) {
      case "rich_text_section":
      case "rich_text_preformatted":
      case "rich_text_quote":
        parts.push(renderSlackRichTextElements(element.elements));
        break;
      case "rich_text_list": {
        const listParts: string[] = [];
        if (Array.isArray(element.elements)) {
          for (const child of element.elements) {
            if (!child || typeof child !== "object") {
              continue;
            }
            const rendered = renderSlackRichTextElements((child as SlackRichTextElement).elements);
            if (rendered) {
              listParts.push(rendered);
            }
          }
        }
        parts.push(listParts.join("\n"));
        break;
      }
      default:
        parts.push(renderSlackRichTextLeaf(element));
        break;
    }
  }
  return parts.join("");
}

function readSlackBlockText(block: unknown): string | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const blockLike = block as SlackBlockLike;
  switch (blockLike.type) {
    case "rich_text":
      return normalizeOptionalString(renderSlackRichTextElements(blockLike.elements));
    case "section": {
      const text = readTextObject(blockLike.text);
      if (text) {
        return text;
      }
      if (!Array.isArray(blockLike.fields)) {
        return undefined;
      }
      const fields = blockLike.fields.flatMap((field) => readTextObject(field) ?? []);
      return fields.length > 0 ? fields.join("\n") : undefined;
    }
    case "header":
      return readTextObject(blockLike.text);
    case "context": {
      if (!Array.isArray(blockLike.elements)) {
        return undefined;
      }
      const parts = blockLike.elements.flatMap((element) => readTextObject(element) ?? []);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    case "image":
      return (
        normalizeOptionalString(readString(blockLike.alt_text)) ?? readTextObject(blockLike.title)
      );
    case "video":
      return (
        readTextObject(blockLike.title) ?? normalizeOptionalString(readString(blockLike.alt_text))
      );
    case "data_visualization":
      return renderSlackDataVisualizationFallbackText(block);
    default:
      return undefined;
  }
}

export function resolveSlackBlocksText(blocks: unknown[] | undefined): SlackBlocksText | undefined {
  if (!blocks?.length) {
    return undefined;
  }
  const parts: string[] = [];
  let hasRichText = false;
  let hasDataVisualization = false;
  for (const block of blocks) {
    if (block && typeof block === "object") {
      const blockType = (block as SlackBlockLike).type;
      hasRichText ||= blockType === "rich_text";
      hasDataVisualization ||= blockType === "data_visualization";
    }
    const text = readSlackBlockText(block);
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0
    ? { text: parts.join("\n"), hasRichText, hasDataVisualization }
    : undefined;
}

export function chooseSlackPrimaryText(params: {
  messageText: string | undefined;
  blocksText: SlackBlocksText | undefined;
}): string | undefined {
  const { messageText, blocksText } = params;
  if (!blocksText) {
    return messageText;
  }
  if (!messageText) {
    return blocksText.text;
  }
  if (blocksText.hasDataVisualization) {
    const comparableMessageText = messageText.replace(/\s+/g, " ").trim();
    const comparableBlocksText = blocksText.text.replace(/\s+/g, " ").trim();
    if (comparableMessageText.includes(comparableBlocksText)) {
      return messageText;
    }
    return comparableBlocksText.startsWith(comparableMessageText)
      ? blocksText.text
      : `${messageText}\n${blocksText.text}`;
  }
  if (blocksText.hasRichText && blocksText.text.length > messageText.length) {
    return blocksText.text;
  }
  return blocksText.text.length > messageText.length && blocksText.text.startsWith(messageText)
    ? blocksText.text
    : messageText;
}
