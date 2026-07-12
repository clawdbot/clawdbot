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
// Telegram rich message helpers isolate Bot API 10.1 calls until grammY types catch up.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  escapeTelegramHtml,
  markdownToTelegramRichHtml,
  normalizeTelegramOutboundRichHtml,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
  type TelegramRichHtmlDegradationReason,
} from "./format.js";

type TelegramRichMessageReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply;

export const TELEGRAM_RICH_TEXT_LIMIT = 32_768;
const TELEGRAM_RICH_BLOCK_LIMIT = 500;
const TELEGRAM_RICH_MEDIA_LIMIT = 50;

export type TelegramInputRichMessage =
  | {
      markdown: string;
      html?: never;
      is_rtl?: boolean;
      skip_entity_detection?: boolean;
    }
  | {
      html: string;
      markdown?: never;
      is_rtl?: boolean;
      skip_entity_detection?: boolean;
    };

type TelegramInputRichHtmlMessage = Extract<TelegramInputRichMessage, { html: string }>;

type TelegramRichMessageOptions = {
  skipEntityDetection?: boolean;
  tableMode?: MarkdownTableMode;
};

type TelegramRichTextMode = "markdown" | "html";

export type TelegramRichTextChunk = {
  text: string;
  textMode: "html";
  plainText: string;
  skipEntityDetection: boolean;
  degradationReasons: readonly TelegramRichHtmlDegradationReason[];
};

type TelegramRichMessagePlan = {
  richMessage: TelegramInputRichHtmlMessage;
  degradationReasons: readonly TelegramRichHtmlDegradationReason[];
};

export type TelegramSendRichMessageParams = {
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

export function buildTelegramRichMarkdownPlan(
  markdown: string,
  options?: TelegramRichMessageOptions,
): TelegramRichMessagePlan {
  const richOptions = {
    ...options,
    skipEntityDetection: shouldSkipTelegramRichEntityDetection(markdown, options),
  };
  return buildTelegramRichHtmlPlan(markdownToTelegramRichHtml(markdown, richOptions), richOptions);
}

export function buildTelegramRichMarkdown(
  markdown: string,
  options?: TelegramRichMessageOptions,
): TelegramInputRichMessage {
  return buildTelegramRichMarkdownPlan(markdown, options).richMessage;
}

export function buildTelegramRichHtmlPlan(
  html: string,
  options?: TelegramRichMessageOptions,
): TelegramRichMessagePlan {
  const normalized = prepareTelegramRichHtml(html);
  const richMessage = shouldSkipTelegramRichEntityDetection(normalized.html, options)
    ? { html: normalized.html, skip_entity_detection: true }
    : { html: normalized.html };
  return {
    richMessage,
    degradationReasons: normalized.degradationReasons,
  };
}

export function buildTelegramRichHtml(
  html: string,
  options?: TelegramRichMessageOptions,
): TelegramInputRichMessage {
  return buildTelegramRichHtmlPlan(html, options).richMessage;
}

export function buildTelegramRichMessagePlan(
  text: string,
  textMode: TelegramRichTextMode,
  options?: TelegramRichMessageOptions,
): TelegramRichMessagePlan {
  return textMode === "html"
    ? buildTelegramRichHtmlPlan(text, options)
    : buildTelegramRichMarkdownPlan(text, options);
}

function prepareTelegramRichHtml(html: string) {
  return normalizeTelegramOutboundRichHtml(html);
}

const TELEGRAM_RICH_HTML_CHUNK_LIMITS = {
  blockLimit: TELEGRAM_RICH_BLOCK_LIMIT,
  mediaLimit: TELEGRAM_RICH_MEDIA_LIMIT,
} as const;

function splitPreparedTelegramRichHtml(params: {
  html: string;
  sourceFallback: string;
  textLimit: number;
}): string[] {
  try {
    const chunks = splitTelegramHtmlChunks(
      params.html,
      params.textLimit,
      TELEGRAM_RICH_HTML_CHUNK_LIMITS,
    );
    if (chunks.length > 0) {
      return chunks;
    }
  } catch {
    // Fall through to readable source text when rich planning cannot preserve the payload.
  }
  return splitTelegramHtmlChunks(escapeTelegramHtml(params.sourceFallback), params.textLimit);
}

type RichMarkdownFenceSpan = {
  start: number;
  end: number;
};

function parseRichMarkdownFenceSpans(markdown: string): RichMarkdownFenceSpan[] {
  const spans: RichMarkdownFenceSpan[] = [];
  let open:
    | {
        start: number;
        markerChar: string;
        markerLength: number;
      }
    | undefined;
  let offset = 0;
  while (offset <= markdown.length) {
    const nextNewline = markdown.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? markdown.length : nextNewline;
    const line = markdown.slice(offset, lineEnd);
    const match = line.match(/^( {0,3})(`{3,}|~{3,})/);
    if (match) {
      const marker = expectDefined(match[2], "Markdown fence marker capture");
      const markerChar = marker.charAt(0);
      if (!open) {
        open = { start: offset, markerChar, markerLength: marker.length };
      } else if (open.markerChar === markerChar && marker.length >= open.markerLength) {
        spans.push({ start: open.start, end: lineEnd });
        open = undefined;
      }
    }
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }
  if (open) {
    spans.push({ start: open.start, end: markdown.length });
  }
  return spans;
}

function isSafeRichMarkdownBlockBreak(spans: readonly RichMarkdownFenceSpan[], index: number) {
  return !spans.some((span) => index > span.start && index < span.end);
}

type RichMarkdownBlockBreak = {
  start: number;
  end: number;
  separator: string;
};

function findTelegramRichMarkdownBlockBreaks(markdown: string): RichMarkdownBlockBreak[] {
  const breaks: RichMarkdownBlockBreak[] = [];
  for (const match of markdown.matchAll(/\n[\t ]*\n+/g)) {
    const start = match.index ?? 0;
    breaks.push({
      start,
      end: start + match[0].length,
      separator: match[0],
    });
  }
  for (const match of markdown.matchAll(/^ {0,3}#{1,6}\s+\S.*$/gm)) {
    const headingStart = match.index ?? 0;
    if (headingStart > 0 && markdown[headingStart - 1] === "\n") {
      breaks.push({
        start: headingStart - 1,
        end: headingStart,
        separator: "\n",
      });
    }
  }
  return breaks.toSorted((left, right) => left.start - right.start || right.end - left.end);
}

function splitTelegramRichMarkdownBlocks(markdown: string, blockLimit: number): string[] {
  if (!markdown.trim()) {
    return markdown ? [markdown] : [];
  }

  const blocks: Array<{ text: string; separatorBefore?: string }> = [];
  const fenceSpans = parseRichMarkdownFenceSpans(markdown);
  let lastIndex = 0;
  let separatorBefore: string | undefined;
  for (const blockBreak of findTelegramRichMarkdownBlockBreaks(markdown)) {
    if (blockBreak.start < lastIndex) {
      continue;
    }
    if (!isSafeRichMarkdownBlockBreak(fenceSpans, blockBreak.start)) {
      continue;
    }
    const text = markdown.slice(lastIndex, blockBreak.start);
    if (text.trim()) {
      blocks.push({ text, ...(separatorBefore ? { separatorBefore } : {}) });
    }
    separatorBefore = blockBreak.separator;
    lastIndex = blockBreak.end;
  }
  const tail = markdown.slice(lastIndex);
  if (tail.trim()) {
    blocks.push({ text: tail, ...(separatorBefore ? { separatorBefore } : {}) });
  }

  if (blocks.length <= blockLimit) {
    return [markdown];
  }

  const chunks: string[] = [];
  let chunk = "";
  let chunkBlocks = 0;
  for (const block of blocks) {
    if (chunkBlocks >= blockLimit) {
      chunks.push(chunk);
      chunk = "";
      chunkBlocks = 0;
    }
    const separator = chunk ? (block.separatorBefore ?? "\n\n") : "";
    chunk += `${separator}${block.text}`;
    chunkBlocks += 1;
  }
  if (chunk) {
    chunks.push(chunk);
  }
  return chunks;
}

function splitTelegramRichMarkdownTextChunks(
  markdown: string,
  textLimit: number,
  chunkMode: ChunkMode,
): string[] {
  const chunks: string[] = [];
  const queue = chunkMarkdownTextWithMode(markdown, textLimit, chunkMode);
  for (let index = 0; index < queue.length; index += 1) {
    const chunk = queue[index] ?? "";
    if (chunk.length <= textLimit) {
      chunks.push(chunk);
      continue;
    }
    const reducedLimit = Math.max(1, Math.min(chunk.length - 1, textLimit - 16));
    const nextChunks = chunkMarkdownTextWithMode(chunk, reducedLimit, chunkMode);
    if (nextChunks.length <= 1) {
      chunks.push(chunk);
      continue;
    }
    queue.splice(index, 1, ...nextChunks);
    index -= 1;
  }
  return chunks;
}

export function splitTelegramRichMarkdownChunks(
  markdown: string,
  textLimit: number,
  chunkMode: ChunkMode,
): string[] {
  if (markdown.length <= textLimit) {
    return splitTelegramRichMarkdownBlocks(markdown, TELEGRAM_RICH_BLOCK_LIMIT);
  }
  return splitTelegramRichMarkdownTextChunks(markdown, textLimit, chunkMode).flatMap((chunk) =>
    splitTelegramRichMarkdownBlocks(chunk, TELEGRAM_RICH_BLOCK_LIMIT),
  );
}

export function splitTelegramRichMessageTextChunks(params: {
  text: string;
  textLimit: number;
  textMode: TelegramRichTextMode;
  chunkMode: ChunkMode;
  tableMode?: MarkdownTableMode;
  skipEntityDetection?: boolean;
}): TelegramRichTextChunk[] {
  const renderRichChunk = (chunk: string, textMode: TelegramRichTextMode) => {
    const skipEntityDetection = shouldSkipTelegramRichEntityDetection(chunk, {
      skipEntityDetection: params.skipEntityDetection,
    });
    const normalized =
      textMode === "html"
        ? prepareTelegramRichHtml(chunk)
        : prepareTelegramRichHtml(
            markdownToTelegramRichHtml(chunk, {
              tableMode: params.tableMode,
              skipEntityDetection,
            }),
          );
    return { normalized, skipEntityDetection };
  };
  const richChunks =
    params.textMode === "html"
      ? [
          {
            source: params.text,
            rendered: renderRichChunk(params.text, "html"),
          },
        ]
      : splitTelegramRichMarkdownChunks(params.text, params.textLimit, params.chunkMode).map(
          (chunk) => ({
            source: chunk,
            rendered: renderRichChunk(chunk, "markdown"),
          }),
        );
  return richChunks.flatMap(({ source, rendered }) =>
    splitPreparedTelegramRichHtml({
      html: rendered.normalized.html,
      sourceFallback: source,
      textLimit: params.textLimit,
    }).map((chunk, index) => ({
      text: chunk,
      textMode: "html",
      plainText: telegramHtmlToPlainTextFallback(chunk),
      skipEntityDetection: shouldSkipTelegramRichEntityDetection(chunk, {
        skipEntityDetection: params.skipEntityDetection,
      }),
      degradationReasons: index === 0 ? rendered.normalized.degradationReasons : [],
    })),
  );
}
