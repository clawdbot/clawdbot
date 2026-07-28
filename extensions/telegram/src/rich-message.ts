import type { Bot } from "grammy";
import type {
  ForceReply,
  InlineKeyboardMarkup,
  Message,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  ReplyParameters,
} from "grammy/types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
// Telegram rich message helpers isolate Bot API 10.2 calls until grammY types catch up.
import {
  inputRichBlocksToPlainText,
  type InputRichBlock,
  type TelegramRichBlocksDegradationReason,
} from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";

type TelegramRichMessageReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply;

export const TELEGRAM_RICH_TEXT_LIMIT = 32_768;
const TELEGRAM_RICH_BLOCK_LIMIT = 500;

// The rich wire path is blocks-only: caller-authored HTML (formatting.parseMode
// "HTML") stays on the legacy parse_mode HTML funnel even for rich accounts, so
// literal-newline and chunking semantics match what HTML callers authored against.
export type TelegramInputRichMessage = {
  blocks: InputRichBlock[];
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
};

export function isEmptyTelegramRichMessage(richMessage: TelegramInputRichMessage): boolean {
  return richMessage.blocks.length === 0;
}

type TelegramRichMessageOptions = {
  skipEntityDetection?: boolean;
  tableMode?: MarkdownTableMode;
};

export type TelegramRichTextChunk = {
  richMessage: TelegramInputRichMessage;
  plainText: string;
  degradationReasons: readonly TelegramRichBlocksDegradationReason[];
};

type TelegramRichMessagePlan = {
  richMessage: TelegramInputRichMessage;
  plainText: string;
  degradationReasons: readonly TelegramRichBlocksDegradationReason[];
};

type TelegramSendRichMessageParams = {
  business_connection_id?: string;
  chat_id: number | string;
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  rich_message: TelegramInputRichMessage;
  disable_notification?: boolean;
  protect_content?: boolean;
  allow_paid_broadcast?: boolean;
  message_effect_id?: string;
  suggested_post_parameters?: unknown;
  reply_parameters?: ReplyParameters;
  reply_markup?: TelegramRichMessageReplyMarkup;
};

export type TelegramRichMessageContextParams = Pick<
  TelegramSendRichMessageParams,
  "disable_notification" | "message_thread_id" | "reply_parameters"
>;

export type TelegramEditRichMessageTextParams = {
  business_connection_id?: string;
  chat_id?: number | string;
  message_id?: number;
  inline_message_id?: string;
  rich_message: TelegramInputRichMessage;
  reply_markup?: InlineKeyboardMarkup;
};

type TelegramRichRawApi = {
  sendRichMessage: (params: TelegramSendRichMessageParams) => Promise<Message>;
  editMessageText: (params: TelegramEditRichMessageTextParams) => Promise<Message | true>;
};

type TelegramApiWithRichRaw = Bot["api"] & {
  raw?: TelegramRichRawApi;
};

const TELEGRAM_RICH_EMAIL_TOKEN_RE =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/iu;

function shouldSkipTelegramRichEntityDetection(
  text: string,
  options?: Pick<TelegramRichMessageOptions, "skipEntityDetection">,
): boolean {
  return options?.skipEntityDetection === true || TELEGRAM_RICH_EMAIL_TOKEN_RE.test(text);
}

export function getTelegramRichRawApi(api: Bot["api"]): TelegramRichRawApi {
  const raw = (api as TelegramApiWithRichRaw).raw;
  if (raw) {
    return raw;
  }
  throw new Error("Telegram rich messages require grammY api.raw");
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
  const messageThreadId = finiteInteger(params?.message_thread_id);
  if (messageThreadId !== undefined) {
    richParams.message_thread_id = messageThreadId;
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
  options?: TelegramRichMessageOptions & { plainText?: string },
): TelegramRichMessagePlan {
  const plainText = options?.plainText ?? inputRichBlocksToPlainText(blocks);
  return {
    richMessage: toRichMessage(blocks, plainText, options),
    plainText,
    degradationReasons: [],
  };
}

export function splitTelegramRichMessageTextChunks(params: {
  text: string;
  textLimit: number;
  tableMode?: MarkdownTableMode;
  skipEntityDetection?: boolean;
}): TelegramRichTextChunk[] {
  // Convert the full markdown document first so fences/tables stay intact, then
  // enforce block/char limits on the typed block list (including oversized pre).
  const plan = buildTelegramRichMarkdownPlan(params.text, {
    tableMode: params.tableMode,
    skipEntityDetection: params.skipEntityDetection,
  });
  // The render already committed to the document-level linkify decision (a
  // skip anywhere disables our file-ref code-wrapping everywhere), so every
  // chunk must carry the same wire flag; re-deriving per chunk would let
  // Telegram re-linkify unprotected chunks.
  const skipEntityDetection = plan.richMessage.skip_entity_detection === true;
  const chunkOptions = { skipEntityDetection };
  const chunked = splitTelegramRichBlocks(plan.richMessage.blocks, {
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
  if (chunked.length === 0 && params.text.trim()) {
    // Markdown that projects to zero blocks (e.g. link definitions only) must
    // still send readable source text instead of silently dropping the reply.
    const blocks: InputRichBlock[] = [{ type: "paragraph", text: params.text }];
    return [
      {
        richMessage: toRichMessage(blocks, params.text, chunkOptions),
        plainText: params.text,
        degradationReasons: plan.degradationReasons,
      },
    ];
  }
  return chunked;
}
