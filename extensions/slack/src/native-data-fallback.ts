import type { Block, KnownBlock } from "@slack/web-api";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { renderSlackBlockFallbackText } from "./blocks-fallback.js";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { SLACK_MESSAGE_TEXT_HARD_LIMIT, SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT } from "./limits.js";
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

type SlackNativeDataDeliveryPlan = {
  accessibilityText: string;
  fallbackMessages: SlackFormattingDisabledMessage[];
  skipOriginalBlocks: boolean;
};

type OrderedFallbackBlock = {
  block: Block | KnownBlock;
  text?: string;
  continuesText?: boolean;
};

function sliceSlackTextChunk(text: string, start: number, limit: number): string {
  return (
    sliceUtf16Safe(text, start, Math.min(text.length, start + limit)) ||
    Array.from(text.slice(start))[0] ||
    ""
  );
}

export function chunkSlackTextAtHardLimit(
  text: string,
  limit = SLACK_MESSAGE_TEXT_HARD_LIMIT,
): string[] {
  const effectiveLimit = Math.max(1, Math.floor(limit));
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const chunk = sliceSlackTextChunk(text, offset, effectiveLimit);
    if (!chunk) {
      throw new Error("Slack plain-text fallback chunking made no progress.");
    }
    chunks.push(chunk);
    offset += chunk.length;
  }
  return chunks;
}

function fitsSlackTextLimit(text: string, limit: number): boolean {
  if (text.length <= limit) {
    return true;
  }
  return sliceSlackTextChunk(text, 0, limit).length === text.length;
}

function buildPlainTextBlocks(text: string, textLimit: number): OrderedFallbackBlock[] {
  return chunkSlackTextAtHardLimit(text, Math.min(textLimit, SLACK_SECTION_PLAIN_TEXT_MAX)).map(
    (chunk, index) => {
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
    },
  );
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
  textLimit: number;
}): OrderedFallbackBlock[] {
  const entries: OrderedFallbackBlock[] = [];
  const consumeFromBase = createSlackNativeDataBaseTextConsumer(params.baseText);
  if (params.baseText) {
    entries.push(...buildPlainTextBlocks(params.baseText, params.textLimit));
  }
  for (const block of params.blocks) {
    if (hasSlackNativeDataBlock([block])) {
      const nativeText = renderNativeDataPlainText(block);
      if (!consumeFromBase(nativeText)) {
        entries.push(...buildPlainTextBlocks(nativeText, params.textLimit));
      }
      continue;
    }
    const text = renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" });
    entries.push({ block, ...(text ? { text } : {}) });
  }
  return entries;
}

function buildOrderedBlockMessages(entries: readonly OrderedFallbackBlock[], textLimit: number) {
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
    if (blocks.length >= SLACK_MAX_BLOCKS || !fitsSlackTextLimit(nextText, textLimit)) {
      flush();
    }
    const freshSeparator = text && entry.text && !entry.continuesText ? "\n\n" : "";
    const freshText = entry.text ? `${text}${freshSeparator}${entry.text}` : text;
    if (!fitsSlackTextLimit(freshText, textLimit)) {
      throw new Error("One Slack fallback block exceeds the resolved message text limit.");
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
  textLimit?: number;
}): SlackNativeDataDeliveryPlan {
  const baseText = params.baseText?.trim() ?? "";
  const textLimit = Math.min(
    SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT,
    SLACK_MESSAGE_TEXT_HARD_LIMIT,
    Math.max(1, Math.floor(params.textLimit ?? SLACK_MESSAGE_TEXT_HARD_LIMIT)),
  );
  const hasNativeData = hasSlackNativeDataBlock(params.blocks);
  const accessibilityText =
    buildSlackNativeDataAccessibilityText(baseText, params.blocks) ||
    (hasNativeData ? SLACK_MALFORMED_NATIVE_DATA_FALLBACK : SLACK_EMPTY_BLOCK_FALLBACK);
  const survivorBlocks = stripSlackNativeDataBlocks(params.blocks);
  const fallbackMessages =
    survivorBlocks.length === 0
      ? chunkSlackTextAtHardLimit(accessibilityText, textLimit).map((text) => ({
          text,
          mrkdwn: false as const,
        }))
      : buildOrderedBlockMessages(
          buildOrderedFallbackBlocks({
            baseText,
            blocks: params.blocks,
            textLimit,
          }),
          textLimit,
        );
  return {
    accessibilityText,
    fallbackMessages,
    skipOriginalBlocks: accessibilityText.length > SLACK_MESSAGE_TEXT_HARD_LIMIT,
  };
}
