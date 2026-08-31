// withTelegramPlainFallback owns formatted-to-plain recovery for durable sends,
// final replies, and draft previews. A second orchestrator reintroduces silent drift.
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import type { TelegramRichBlocksDegradationReason } from "./rich-block-model.js";

// Any RICH_MESSAGE_*_INVALID rejection (entities, media, depth) degrades to
// plain text; media content validity (e.g. AUDIO_INVALID for a non-decodable
// file, live-verified) is only knowable server-side.
const RICH_ENTITY_INVALID_RE = /RICH_MESSAGE_[A-Z_]+_INVALID/i;
const RICH_CONTENT_REQUIRED_RE = /RICH_MESSAGE_CONTENT_REQUIRED/i;
const EMPTY_TEXT_RE = /message text is empty|text must be non-empty/i;
// Structural-limit rejections, live-verified against Bot API 10.2 (2026-07-15):
// >500 recursively counted blocks, >16 depth, oversized text, >50 media, >20 table cols.
const RICH_STRUCTURE_INVALID_RE =
  /RICH_MESSAGE_(?:BLOCKS_TOO_MANY|DEPTH_INVALID|TEXT_TOO_LONG|MEDIA_TOO_MANY|TABLE_COLS_TOO_MANY)/i;
const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity|can't parse InputRichBlock/i;

type TelegramRichPlainFallbackTrigger =
  | "rich-entity-invalid"
  | "rich-structure-invalid"
  | "html-parse"
  | "rich-content-required";

type TelegramPlainFallbackTrigger = TelegramRichPlainFallbackTrigger | "empty-content";

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

export function isTelegramEmptyContentError(err: unknown): boolean {
  const message = formatErrorMessage(err);
  return EMPTY_TEXT_RE.test(message) || RICH_CONTENT_REQUIRED_RE.test(message);
}

function getTelegramPlainFallbackTrigger(
  err: unknown,
): TelegramRichPlainFallbackTrigger | undefined {
  if (isTelegramRichEntityInvalidError(err)) {
    return "rich-entity-invalid";
  }
  if (RICH_CONTENT_REQUIRED_RE.test(formatErrorMessage(err))) {
    return "rich-content-required";
  }
  if (RICH_STRUCTURE_INVALID_RE.test(formatErrorMessage(err))) {
    return "rich-structure-invalid";
  }
  if (isTelegramHtmlParseError(err)) {
    return "html-parse";
  }
  return undefined;
}

export function surrogateSafeChunkEnd(text: string, end: number, start: number): number {
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
  return chunkTextForOutbound(text, normalizedLimit, { preserveWhitespace: true });
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

export async function withTelegramPlainFallback<T>(params: {
  kind: "rich" | "html";
  context: string;
  plainText: string;
  warn: (message: string) => void;
  limit?: number;
  chunkCount?: number;
  sendFormatted: () => Promise<T>;
  sendPlain: (plan: TelegramPlainFallbackPlan, label: string) => Promise<T>;
}): Promise<T> {
  try {
    return await params.sendFormatted();
  } catch (err) {
    const trigger: TelegramPlainFallbackTrigger | undefined =
      params.kind === "rich"
        ? getTelegramPlainFallbackTrigger(err)
        : isTelegramHtmlParseError(err)
          ? "html-parse"
          : isTelegramEmptyContentError(err)
            ? "empty-content"
            : undefined;
    if (!trigger || !params.plainText.trim()) {
      throw err;
    }
    params.warn(
      `telegram ${params.context} degrade=plain-fallback:${trigger}: ${formatErrorMessage(err)}`,
    );
    const limit = params.limit ?? 4000;
    const chunks =
      params.chunkCount === undefined
        ? splitTelegramPlainTextChunks(params.plainText, limit)
        : splitTelegramPlainTextFallback(params.plainText, params.chunkCount, limit);
    return await params.sendPlain(
      {
        plainText: params.plainText,
        chunks,
      },
      `${params.context}-plain`,
    );
  }
}

export function warnTelegramRichBlocksDegradations(params: {
  context: string;
  reasons: readonly TelegramRichBlocksDegradationReason[];
  warn: (message: string) => void;
}): void {
  for (const reason of new Set(params.reasons)) {
    params.warn(`telegram ${params.context} rich-degrade=${reason}`);
  }
}
