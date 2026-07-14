// Telegram rich/plain fallback policy is shared by durable sends, final replies,
// and draft previews. A second copy reintroduces silent drift in parse failures.
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  telegramHtmlToPlainTextFallback,
  type TelegramRichHtmlDegradationReason,
} from "./format.js";

const RICH_ENTITY_INVALID_RE =
  /RICH_MESSAGE_(?:EMAIL|URL|MENTION|HASHTAG|CASHTAG|BOT_COMMAND|PHONE|BANK_CARD)_INVALID/i;
const RICH_CONTENT_REQUIRED_RE = /RICH_MESSAGE_CONTENT_REQUIRED/i;
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;

type TelegramPlainFallbackTrigger = "rich-entity-invalid" | "html-parse" | "rich-content-required";

type TelegramPlainFallbackPlan = {
  plainText: string;
  chunks: string[];
};

function isTelegramRichEntityInvalidError(err: unknown): boolean {
  return RICH_ENTITY_INVALID_RE.test(formatErrorMessage(err));
}

export function isTelegramHtmlParseError(err: unknown): boolean {
  return PARSE_ERR_RE.test(formatErrorMessage(err));
}

function getTelegramPlainFallbackTrigger(err: unknown): TelegramPlainFallbackTrigger | undefined {
  if (isTelegramRichEntityInvalidError(err)) {
    return "rich-entity-invalid";
  }
  if (RICH_CONTENT_REQUIRED_RE.test(formatErrorMessage(err))) {
    return "rich-content-required";
  }
  if (isTelegramHtmlParseError(err)) {
    return "html-parse";
  }
  return undefined;
}

function surrogateSafeChunkEnd(text: string, end: number, start: number): number {
  const high = text.charCodeAt(end - 1);
  const low = text.charCodeAt(end);
  const splitsPair = end > 0 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  if (!splitsPair) {
    return end;
  }
  const clamped = end - 1;
  return clamped > start ? clamped : start + 2;
}

export function splitTelegramPlainTextChunks(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = surrogateSafeChunkEnd(text, start + normalizedLimit, start);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function splitTelegramPlainTextFallback(text: string, chunkCount: number, limit: number): string[] {
  if (!text) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const fixedChunks = splitTelegramPlainTextChunks(text, normalizedLimit);
  if (chunkCount <= 1 || fixedChunks.length >= chunkCount) {
    return fixedChunks;
  }
  const chunks: string[] = [];
  let offset = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const remainingChars = text.length - offset;
    const remainingChunks = chunkCount - index;
    const nextChunkLength =
      remainingChunks === 1
        ? remainingChars
        : Math.min(normalizedLimit, Math.ceil(remainingChars / remainingChunks));
    const end = surrogateSafeChunkEnd(text, offset + nextChunkLength, offset);
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function buildTelegramPlainFallbackPlan(params: {
  html: string;
  err: unknown;
  context: string;
  warn: (message: string) => void;
  limit?: number;
  chunkCount?: number;
}): TelegramPlainFallbackPlan | undefined {
  const trigger = getTelegramPlainFallbackTrigger(params.err);
  if (!trigger) {
    return undefined;
  }
  const plainText = telegramHtmlToPlainTextFallback(params.html);
  const limit = params.limit ?? 4000;
  const chunks =
    params.chunkCount === undefined
      ? splitTelegramPlainTextChunks(plainText, limit)
      : splitTelegramPlainTextFallback(plainText, params.chunkCount, limit);
  params.warn(
    `telegram ${params.context} rich-degrade=plain-fallback:${trigger}: ${formatErrorMessage(
      params.err,
    )}`,
  );
  return {
    plainText,
    chunks,
  };
}

export function warnTelegramRichHtmlDegradations(params: {
  context: string;
  reasons: readonly TelegramRichHtmlDegradationReason[];
  warn: (message: string) => void;
}): void {
  for (const reason of new Set(params.reasons)) {
    params.warn(`telegram ${params.context} rich-degrade=${reason}`);
  }
}
