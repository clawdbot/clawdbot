import type { Block, KnownBlock } from "@slack/web-api";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { renderSlackBlockFallbackText } from "./blocks-fallback.js";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { SLACK_MESSAGE_TEXT_HARD_LIMIT } from "./limits.js";
import {
  buildSlackNativeDataAccessibilityText,
  appendSlackNativeDataPlainTextFallback,
  createSlackNativeDataBaseTextConsumer,
  hasSlackNativeDataBlock,
  SLACK_MALFORMED_NATIVE_DATA_FALLBACK,
  stripSlackNativeDataBlocks,
} from "./native-data-blocks.js";

const SLACK_SECTION_PLAIN_TEXT_MAX = 3_000;
const SLACK_EMPTY_BLOCK_FALLBACK = "Shared a Block Kit message";

export type SlackFormattingDisabledMessage = {
  text: string;
  blocks?: (Block | KnownBlock)[];
  mrkdwn: false;
};

export type SlackNativeDataDeliveryPlan = {
  accessibilityText: string;
  fallbackMessages: SlackFormattingDisabledMessage[];
  skipOriginalBlocks: boolean;
};

type OrderedFallbackBlock = {
  block: Block | KnownBlock;
  text?: string;
  continuesText?: boolean;
};

export function chunkSlackTextAtHardLimit(
  text: string,
  limit = SLACK_MESSAGE_TEXT_HARD_LIMIT,
): string[] {
  const effectiveLimit = Math.max(2, Math.floor(limit));
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const chunk = sliceUtf16Safe(text, offset, Math.min(text.length, offset + effectiveLimit));
    if (!chunk) {
      throw new Error("Slack plain-text fallback chunking made no progress.");
    }
    chunks.push(chunk);
    offset += chunk.length;
  }
  return chunks;
}

function buildPlainTextBlocks(text: string): OrderedFallbackBlock[] {
  return chunkSlackTextAtHardLimit(text, SLACK_SECTION_PLAIN_TEXT_MAX).map((chunk, index) => {
    const fallbackBlock: OrderedFallbackBlock = {
      block: {
        type: "section",
        text: { type: "plain_text", text: chunk },
      },
      text: chunk,
    };
    if (index > 0) {
      fallbackBlock.continuesText = true;
    }
    return fallbackBlock;
  });
}

function renderNativeDataPlainText(block: unknown): string {
  return (
    appendSlackNativeDataPlainTextFallback("", [block]).trim() ||
    SLACK_MALFORMED_NATIVE_DATA_FALLBACK
  );
}

function buildOrderedFallbackBlocks(params: {
  baseText: string;
  blocks: readonly (Block | KnownBlock)[];
}): OrderedFallbackBlock[] {
  const entries: OrderedFallbackBlock[] = [];
  const consumeFromBase = createSlackNativeDataBaseTextConsumer(params.baseText);
  if (params.baseText) {
    entries.push(...buildPlainTextBlocks(params.baseText));
  }
  for (const block of params.blocks) {
    if (hasSlackNativeDataBlock([block])) {
      const nativeText = renderNativeDataPlainText(block);
      if (!consumeFromBase(nativeText)) {
        entries.push(...buildPlainTextBlocks(nativeText));
      }
      continue;
    }
    const text = renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" });
    entries.push({ block, ...(text ? { text } : {}) });
  }
  return entries;
}

function buildOrderedBlockMessages(entries: readonly OrderedFallbackBlock[]) {
  const messages: SlackFormattingDisabledMessage[] = [];
  let blocks: (Block | KnownBlock)[] = [];
  let text = "";

  const flush = () => {
    if (blocks.length === 0) {
      return;
    }
    messages.push({
      text: text || SLACK_EMPTY_BLOCK_FALLBACK,
      blocks,
      mrkdwn: false,
    });
    blocks = [];
    text = "";
  };

  for (const entry of entries) {
    const separator = text && entry.text && !entry.continuesText ? "\n\n" : "";
    const nextText = entry.text ? `${text}${separator}${entry.text}` : text;
    if (blocks.length >= SLACK_MAX_BLOCKS || nextText.length > SLACK_MESSAGE_TEXT_HARD_LIMIT) {
      flush();
    }
    const freshSeparator = text && entry.text && !entry.continuesText ? "\n\n" : "";
    const freshText = entry.text ? `${text}${freshSeparator}${entry.text}` : text;
    if (freshText.length > SLACK_MESSAGE_TEXT_HARD_LIMIT) {
      throw new Error("One Slack fallback block exceeds the message text hard limit.");
    }
    blocks.push(entry.block);
    text = freshText;
  }
  flush();
  return messages;
}

/** Build one complete, ordered retry plan after Slack rejects native data blocks. */
export function buildSlackNativeDataDeliveryPlan(params: {
  baseText?: string;
  blocks: readonly (Block | KnownBlock)[];
}): SlackNativeDataDeliveryPlan {
  const baseText = params.baseText?.trim() ?? "";
  const hasNativeData = hasSlackNativeDataBlock(params.blocks);
  const accessibilityText =
    buildSlackNativeDataAccessibilityText(baseText, params.blocks) ||
    (hasNativeData ? SLACK_MALFORMED_NATIVE_DATA_FALLBACK : SLACK_EMPTY_BLOCK_FALLBACK);
  const survivorBlocks = stripSlackNativeDataBlocks(params.blocks);
  const fallbackMessages =
    survivorBlocks.length === 0
      ? chunkSlackTextAtHardLimit(accessibilityText).map((text) => ({
          text,
          mrkdwn: false as const,
        }))
      : buildOrderedBlockMessages(
          buildOrderedFallbackBlocks({
            baseText,
            blocks: params.blocks,
          }),
        );
  return {
    accessibilityText,
    fallbackMessages,
    skipOriginalBlocks: accessibilityText.length > SLACK_MESSAGE_TEXT_HARD_LIMIT,
  };
}
