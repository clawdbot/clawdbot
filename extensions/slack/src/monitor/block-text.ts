import { renderSlackBlockFallbackText } from "../blocks-fallback.js";

type SlackBlocksText = {
  text: string;
  hasRichText: boolean;
  hasNativeData: boolean;
};

function readSlackBlockType(block: unknown): unknown {
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as { type?: unknown }).type
    : undefined;
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
    hasNativeData ||= blockType === "data_visualization" || blockType === "data_table";
    const text = renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" });
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? { text: parts.join("\n"), hasRichText, hasNativeData } : undefined;
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
