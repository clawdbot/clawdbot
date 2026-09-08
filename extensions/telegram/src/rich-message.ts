import type { Bot } from "grammy";
import type { InputRichMessage, ReplyParameters } from "grammy/types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  inputRichBlocksToPlainText,
  type InputRichBlock,
  type TelegramRichBlocksDegradationReason,
} from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";

export const TELEGRAM_RICH_TEXT_LIMIT = 32_768;
const TELEGRAM_RICH_BLOCK_LIMIT = 500;

// The rich wire path is blocks-only: caller-authored HTML (formatting.parseMode
// "HTML") stays on the legacy parse_mode HTML funnel even for rich accounts, so
// literal-newline and chunking semantics match what HTML callers authored against.
export type TelegramInputRichMessage = Omit<InputRichMessage, "blocks"> & {
  blocks: InputRichBlock[];
};

type TelegramRichMessageOptions = {
  skipEntityDetection?: boolean;
  tableMode?: MarkdownTableMode;
};

type TelegramRichMessagePlan = {
  richMessage: TelegramInputRichMessage;
  plainText: string;
  degradationReasons: readonly TelegramRichBlocksDegradationReason[];
};

type TelegramSendRichMessageOptions = NonNullable<Parameters<Bot["api"]["sendRichMessage"]>[2]>;

export type TelegramRichMessageContextParams = Pick<
  TelegramSendRichMessageOptions,
  "disable_notification" | "direct_messages_topic_id" | "message_thread_id" | "reply_parameters"
>;

const TELEGRAM_RICH_EMAIL_TOKEN_RE =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/iu;

function shouldSkipTelegramRichEntityDetection(
  text: string,
  options?: Pick<TelegramRichMessageOptions, "skipEntityDetection">,
): boolean {
  return options?.skipEntityDetection === true || TELEGRAM_RICH_EMAIL_TOKEN_RE.test(text);
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function isReplyParameters(value: unknown): value is ReplyParameters {
  if (!value || typeof value !== "object") {
    return false;
  }
  return finiteInteger((value as { message_id?: unknown }).message_id) !== undefined;
}

export function toTelegramRichMessageContextParams(
  params: Record<string, unknown> | undefined,
): TelegramRichMessageContextParams {
  const richParams: TelegramRichMessageContextParams = {};
  const directMessagesTopicId = finiteInteger(params?.direct_messages_topic_id);
  if (directMessagesTopicId !== undefined) {
    richParams.direct_messages_topic_id = directMessagesTopicId;
  } else {
    const messageThreadId = finiteInteger(params?.message_thread_id);
    if (messageThreadId !== undefined) {
      richParams.message_thread_id = messageThreadId;
    }
  }
  if (params?.disable_notification === true) {
    richParams.disable_notification = true;
  }
  if (isReplyParameters(params?.reply_parameters)) {
    richParams.reply_parameters = params.reply_parameters;
    return richParams;
  }
  const replyToMessageId = finiteInteger(params?.reply_to_message_id);
  if (replyToMessageId !== undefined) {
    richParams.reply_parameters = {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    };
  }
  return richParams;
}

export function removeTelegramRichNativeQuoteParam(
  params: Record<string, unknown> | undefined,
): TelegramRichMessageContextParams {
  const richParams = toTelegramRichMessageContextParams(params);
  if (!richParams.reply_parameters) {
    return richParams;
  }
  const {
    quote: _quote,
    quote_entities: _quoteEntities,
    quote_parse_mode: _quoteParseMode,
    quote_position: _quotePosition,
    ...replyParameters
  } = richParams.reply_parameters;
  return {
    ...richParams,
    reply_parameters: replyParameters,
  };
}

function toRichMessage(
  blocks: InputRichBlock[],
  plainText: string,
  options?: TelegramRichMessageOptions,
): TelegramInputRichMessage {
  return shouldSkipTelegramRichEntityDetection(plainText, options)
    ? { blocks, skip_entity_detection: true }
    : { blocks };
}

export function buildTelegramRichMarkdownPlan(
  markdown: string,
  options?: TelegramRichMessageOptions,
): TelegramRichMessagePlan {
  const skipEntityDetection = shouldSkipTelegramRichEntityDetection(markdown, options);
  const rendered = markdownToTelegramRichBlocks(markdown, {
    tableMode: options?.tableMode,
    skipEntityDetection,
  });
  return {
    richMessage: toRichMessage(rendered.blocks, rendered.plainText, {
      ...options,
      skipEntityDetection,
    }),
    plainText: rendered.plainText,
    degradationReasons: rendered.degradationReasons,
  };
}

export function buildTelegramRichMarkdown(
  markdown: string,
  options?: TelegramRichMessageOptions,
): TelegramInputRichMessage {
  return buildTelegramRichMarkdownPlan(markdown, options).richMessage;
}

export function buildTelegramRichBlocksPlan(
  blocks: InputRichBlock[],
  options?: Pick<TelegramRichMessageOptions, "skipEntityDetection">,
): TelegramRichMessagePlan {
  const plainText = inputRichBlocksToPlainText(blocks);
  return {
    richMessage: toRichMessage(blocks, plainText, options),
    plainText,
    degradationReasons: [],
  };
}

export function splitTelegramRichMessageTextChunks(params: {
  plan: TelegramRichMessagePlan;
  textLimit: number;
}): TelegramRichMessagePlan[] {
  // Convert the full markdown document first so fences/tables stay intact, then
  // enforce block/char limits on the typed block list (including oversized pre).
  const { plan } = params;
  // The render already committed to the document-level linkify decision (a
  // skip anywhere disables our file-ref code-wrapping everywhere), so every
  // chunk must carry the same wire flag; re-deriving per chunk would let
  // Telegram re-linkify unprotected chunks.
  const skipEntityDetection = plan.richMessage.skip_entity_detection === true;
  const chunkOptions = { skipEntityDetection };
  return splitTelegramRichBlocks(plan.richMessage.blocks, {
    blockLimit: TELEGRAM_RICH_BLOCK_LIMIT,
    textLimit: params.textLimit,
  }).map((blocks, index) => {
    const plainText = inputRichBlocksToPlainText(blocks);
    return {
      richMessage: toRichMessage(blocks, plainText, chunkOptions),
      plainText,
      degradationReasons: index === 0 ? plan.degradationReasons : [],
    };
  });
}
