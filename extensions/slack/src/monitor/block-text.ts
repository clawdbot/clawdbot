import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { renderSlackBlockFallbackText } from "../blocks-fallback.js";

type SlackBlocksText = {
  text: string;
  hasRichText: boolean;
  hasNativeData: boolean;
};

type SlackMessageTextAttachment = {
  blocks?: unknown[];
  app_unfurl_url?: string;
  is_app_unfurl?: boolean;
  is_msg_unfurl?: boolean;
};

type SlackMessageTextSource = {
  text?: string;
  blocks?: unknown[];
  attachments?: SlackMessageTextAttachment[];
};

function readSlackBlockType(block: unknown): unknown {
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as { type?: unknown }).type
    : undefined;
}

export function hasSlackTableBlock(blocks: unknown[] | undefined): boolean {
  return blocks?.some((block) => readSlackBlockType(block) === "table") ?? false;
}

export function hasSlackMessageTableBlock(message: SlackMessageTextSource): boolean {
  return (
    hasSlackTableBlock(message.blocks) ||
    message.attachments?.some(
      (attachment) => !isSlackUnfurlAttachment(attachment) && hasSlackTableBlock(attachment.blocks),
    ) === true
  );
}

export function isSlackUnfurlAttachment(attachment: SlackMessageTextAttachment): boolean {
  return (
    attachment.is_msg_unfurl === true ||
    attachment.is_app_unfurl === true ||
    (typeof attachment.app_unfurl_url === "string" && attachment.app_unfurl_url.trim().length > 0)
  );
}

export function resolveSlackBlocksText(blocks: unknown[] | undefined): SlackBlocksText | undefined {
  if (!blocks?.length) {
    return undefined;
  }
  const parts: string[] = [];
  let hasRichText = false;
  let hasNativeData = false;
  for (const block of blocks) {
    const blockType = readSlackBlockType(block);
    hasRichText ||= blockType === "rich_text";
    hasNativeData ||=
      blockType === "data_visualization" || blockType === "data_table" || blockType === "table";
    const text = renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" });
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? { text: parts.join("\n"), hasRichText, hasNativeData } : undefined;
}

function appendDistinctSlackText(base: string | undefined, addition: string): string {
  if (!base) {
    return addition;
  }
  const comparableBase = `\n${base.replace(/\r\n?/g, "\n")}\n`;
  const comparableAddition = `\n${addition.replace(/\r\n?/g, "\n")}\n`;
  if (comparableBase.includes(comparableAddition)) {
    return base;
  }
  return `${base}\n${addition}`;
}

function resolveSlackAttachmentTableTexts(
  attachments: SlackMessageTextSource["attachments"],
): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const attachment of attachments ?? []) {
    if (isSlackUnfurlAttachment(attachment)) {
      continue;
    }
    for (const block of attachment.blocks ?? []) {
      if (readSlackBlockType(block) !== "table") {
        continue;
      }
      const text = renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" });
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      texts.push(text);
    }
  }
  return texts;
}

/** Resolve agent-visible Slack text while admitting only native tables from attachments. */
export function resolveSlackMessageText(
  message: SlackMessageTextSource,
  options: { preserveMessageTextWhitespace?: boolean } = {},
): string | undefined {
  const messageText = options.preserveMessageTextWhitespace
    ? typeof message.text === "string" && message.text.trim().length > 0
      ? message.text
      : undefined
    : normalizeOptionalString(message.text);
  let resolved = chooseSlackPrimaryText({
    messageText,
    blocksText: resolveSlackBlocksText(message.blocks),
  });
  for (const tableText of resolveSlackAttachmentTableTexts(message.attachments)) {
    resolved = appendDistinctSlackText(resolved, tableText);
  }
  return resolved;
}

function chooseSlackPrimaryText(params: {
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
  if (blocksText.hasNativeData) {
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
