// Slack plugin module implements blocks fallback behavior.
import { renderSlackDataTableMrkdwnFallbackText } from "./data-table.js";
import { renderSlackDataVisualizationMrkdwnFallbackText } from "./data-visualization.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { hasSlackNativeDataBlock } from "./native-data-blocks.js";

type SlackTextObject = { text?: string; type?: string };

type SlackActionElement = {
  type?: string;
  text?: SlackTextObject;
  url?: string;
  placeholder?: SlackTextObject;
  options?: Array<{ text?: SlackTextObject }>;
};

type SlackRichTextElement = {
  type?: string;
  text?: string;
  url?: string;
  user_id?: string;
  channel_id?: string;
  usergroup_id?: string;
  name?: string;
  range?: string;
  fallback?: string;
  elements?: unknown[];
};

type SlackBlockWithFields = {
  type?: string;
  text?: SlackTextObject;
  title?: SlackTextObject;
  alt_text?: string;
  elements?: unknown[];
  fields?: SlackTextObject[];
  accessory?: SlackActionElement;
};

function cleanCandidate(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readTextObject(
  value: SlackTextObject | undefined,
  defaultType?: "plain_text" | "mrkdwn",
): string | undefined {
  const text = cleanCandidate(value?.text);
  return text && (value?.type ?? defaultType) === "plain_text" ? escapeSlackMrkdwn(text) : text;
}

function readSectionText(block: SlackBlockWithFields): string | undefined {
  const parts = [
    readTextObject(block.text),
    ...(block.fields?.map((field) => readTextObject(field)).filter(Boolean) ?? []),
    ...(block.accessory ? readSlackActionElementText(block.accessory) : []),
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function readHeaderText(block: SlackBlockWithFields): string | undefined {
  return readTextObject(block.text, "plain_text");
}

function readImageText(block: SlackBlockWithFields): string | undefined {
  const altText = cleanCandidate(block.alt_text);
  return (
    (altText ? escapeSlackMrkdwn(altText) : undefined) ?? readTextObject(block.title, "plain_text")
  );
}

function readVideoText(block: SlackBlockWithFields): string | undefined {
  const altText = cleanCandidate(block.alt_text);
  return (
    readTextObject(block.title, "plain_text") ?? (altText ? escapeSlackMrkdwn(altText) : undefined)
  );
}

function readContextText(block: SlackBlockWithFields): string | undefined {
  if (!Array.isArray(block.elements)) {
    return undefined;
  }
  const textParts = (block.elements as SlackTextObject[])
    .map((element) => readTextObject(element, "plain_text"))
    .filter((value): value is string => Boolean(value));
  return textParts.length > 0 ? textParts.join(" ") : undefined;
}

function isTextOnlyContextBlock(block: SlackBlockWithFields): boolean {
  if (!Array.isArray(block.elements) || block.elements.length === 0) {
    return false;
  }
  return block.elements.every((rawElement) => {
    if (!rawElement || typeof rawElement !== "object" || Array.isArray(rawElement)) {
      return false;
    }
    const element = rawElement as SlackTextObject;
    return (
      (element.type === "plain_text" || element.type === "mrkdwn") &&
      readTextObject(element) !== undefined
    );
  });
}

function readSlackRichTextLeaf(element: SlackRichTextElement): string {
  switch (element.type) {
    case "text":
      return typeof element.text === "string" ? escapeSlackMrkdwn(element.text) : "";
    case "link": {
      const value = element.text ?? element.url;
      return typeof value === "string" ? escapeSlackMrkdwn(value) : "";
    }
    case "user":
      return element.user_id ? `<@${element.user_id}>` : "";
    case "channel":
      return element.channel_id ? `<#${element.channel_id}>` : "";
    case "usergroup":
      return element.usergroup_id ? `<!subteam^${element.usergroup_id}>` : "";
    case "broadcast":
      return element.range ? `<!${element.range}>` : "";
    case "emoji":
      return element.name ? `:${element.name}:` : "";
    case "date":
      return element.fallback ? escapeSlackMrkdwn(element.fallback) : "";
    default:
      return "";
  }
}

function readSlackRichTextElements(elements: unknown): string {
  if (!Array.isArray(elements)) {
    return "";
  }
  const parts: string[] = [];
  for (const rawElement of elements) {
    if (!rawElement || typeof rawElement !== "object" || Array.isArray(rawElement)) {
      continue;
    }
    const element = rawElement as SlackRichTextElement;
    if (element.type === "rich_text_list") {
      const items = (element.elements ?? [])
        .map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? readSlackRichTextElements((item as SlackRichTextElement).elements)
            : "",
        )
        .filter(Boolean);
      if (items.length > 0) {
        parts.push(items.join("\n"));
      }
      continue;
    }
    if (
      element.type === "rich_text_section" ||
      element.type === "rich_text_preformatted" ||
      element.type === "rich_text_quote"
    ) {
      parts.push(readSlackRichTextElements(element.elements));
      continue;
    }
    parts.push(readSlackRichTextLeaf(element));
  }
  return parts.join("");
}

function readRichText(block: SlackBlockWithFields): string | undefined {
  const text = readSlackRichTextElements(block.elements).trim();
  return text || undefined;
}

function readSlackActionElementText(element: SlackActionElement): string[] {
  if (element.type === "button") {
    const label = readTextObject(element.text, "plain_text");
    if (!label) {
      return [];
    }
    const rawUrl = cleanCandidate(element.url);
    const url = rawUrl ? escapeSlackMrkdwn(rawUrl) : undefined;
    return [`- ${label}${url ? `: ${url}` : ""}`];
  }
  if (element.type === "static_select") {
    const labels =
      element.options
        ?.map((option) => readTextObject(option.text, "plain_text"))
        .filter((label): label is string => Boolean(label)) ?? [];
    if (labels.length === 0) {
      return [];
    }
    const heading = readTextObject(element.placeholder, "plain_text") ?? "Options";
    return [`${heading}:\n${labels.map((label) => `- ${label}`).join("\n")}`];
  }
  return [];
}

function readActionsText(block: SlackBlockWithFields): string | undefined {
  if (!Array.isArray(block.elements)) {
    return undefined;
  }
  const parts = (block.elements as unknown as SlackActionElement[]).flatMap(
    readSlackActionElementText,
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function readSlackBlockFallbackText(raw: unknown): string | undefined {
  const block = raw as SlackBlockWithFields;
  switch (block.type) {
    case "header":
      return readHeaderText(block);
    case "section":
      return readSectionText(block);
    case "rich_text":
      return readRichText(block);
    case "image":
      return readImageText(block) ?? "Shared an image";
    case "video":
      return readVideoText(block) ?? "Shared a video";
    case "file":
      return "Shared a file";
    case "context":
      return readContextText(block);
    case "actions":
      return readActionsText(block);
    case "data_visualization":
      return renderSlackDataVisualizationMrkdwnFallbackText(block);
    case "data_table":
      return renderSlackDataTableMrkdwnFallbackText(block);
    default:
      return undefined;
  }
}

export function buildSlackBlocksFallbackText(blocks: readonly unknown[]): string {
  for (const raw of blocks) {
    const text = readSlackBlockFallbackText(raw);
    if (text) {
      return text;
    }
  }

  return "Shared a Block Kit message";
}

/** Build complete screen-reader fallback text for every retained sibling block. */
export function buildSlackBlocksAccessibleFallbackText(blocks: readonly unknown[]): string {
  const parts = blocks
    .map(readSlackBlockFallbackText)
    .filter((text): text is string => Boolean(text));
  return parts.length > 0 ? parts.join("\n\n") : "Shared a Block Kit message";
}

/** Keep native-data posts compact while their complete fallback is sent separately. */
export function buildSlackBlocksCompactAccessibleFallbackText(blocks: readonly unknown[]): string {
  const parts = blocks
    .map((raw) => {
      const fallback = readSlackBlockFallbackText(raw);
      return hasSlackNativeDataBlock([raw]) ? fallback?.split("\n", 1)[0] : fallback;
    })
    .filter((text): text is string => Boolean(text));
  return parts.length > 0 ? parts.join("\n\n") : "Shared a Block Kit message";
}

/** Keep only native tables whose caption-level accessibility text fits the block post. */
export function retainSlackDataTablesWithinCompactFallback<T>(
  blocks: readonly T[],
  limit: number,
): T[] {
  const retainedTables = new Set<T>();
  for (const block of blocks) {
    if ((block as SlackBlockWithFields).type !== "data_table") {
      continue;
    }
    const candidate = blocks.filter(
      (entry) =>
        (entry as SlackBlockWithFields).type !== "data_table" ||
        retainedTables.has(entry) ||
        entry === block,
    );
    if (buildSlackBlocksCompactAccessibleFallbackText(candidate).length <= limit) {
      retainedTables.add(block);
    }
  }
  return blocks.filter(
    (block) => (block as SlackBlockWithFields).type !== "data_table" || retainedTables.has(block),
  );
}

/** Preserve non-data siblings when a later text part owns rejected native-data fallback. */
export function buildSlackDeferredNativeDataRejectionFallback<T>(blocks: readonly T[]): {
  blocks: T[];
  text: string;
} {
  const retainedBlocks = blocks.filter((block) => !hasSlackNativeDataBlock([block]));
  return {
    blocks: retainedBlocks,
    text:
      retainedBlocks.length > 0
        ? buildSlackBlocksAccessibleFallbackText(retainedBlocks)
        : buildSlackBlocksCompactAccessibleFallbackText(blocks),
  };
}

/** True when visible text can replace this block without losing interaction or media. */
export function isSlackBlockRepresentedByTextFallback(raw: unknown): boolean {
  const block = raw as SlackBlockWithFields;
  switch (block.type) {
    case "section":
      return !block.accessory;
    case "context":
      return isTextOnlyContextBlock(block);
    case "header":
    case "rich_text":
    case "data_visualization":
    case "data_table":
      return true;
    default:
      return false;
  }
}

function comparableFallbackText(value: string): string {
  return value
    .replace(/(^|\n)[ \t]*[-*•][ \t]+/gu, "$1• ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Remove fallback paragraphs already represented by retained visible blocks. */
export function removeSlackBlocksFallbackParagraphs(
  text: string,
  blocks: readonly unknown[],
): string {
  const represented = new Set(
    blocks
      .map(readSlackBlockFallbackText)
      .filter((value): value is string => Boolean(value))
      .map(comparableFallbackText),
  );
  return text
    .split(/\n{2,}/u)
    .filter((paragraph) => !represented.has(comparableFallbackText(paragraph)))
    .join("\n\n")
    .trim();
}

/** Append complete block accessibility text without repeating represented paragraphs. */
export function appendSlackBlocksAccessibleFallbackText(
  text: string,
  blocks: readonly unknown[],
): string {
  const parts = text
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set(parts.map(comparableFallbackText));
  for (const block of blocks) {
    const fallback = readSlackBlockFallbackText(block);
    const comparable = fallback ? comparableFallbackText(fallback) : "";
    if (
      !fallback ||
      !comparable ||
      seen.has(comparable) ||
      parts.some((part) => comparableFallbackText(part).includes(comparable))
    ) {
      continue;
    }
    seen.add(comparable);
    parts.push(fallback);
  }
  return parts.join("\n\n");
}
