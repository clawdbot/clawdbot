import type { TelegramTextEntity } from "./body-helpers.js";

export const TELEGRAM_NATIVE_QUOTE_MAX_LENGTH = 1024;

export type TelegramNativeQuoteCandidate = {
  text: string;
  position?: number;
  entities?: unknown[];
};

export type TelegramNativeQuoteCandidateByMessageId = Record<string, TelegramNativeQuoteCandidate>;

function truncateUtf16Safe(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  let end = Math.max(0, Math.trunc(maxLength));
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

function sliceTelegramEntitiesForQuote(
  entities: readonly TelegramTextEntity[] | undefined,
  quoteLength: number,
): TelegramTextEntity[] | undefined {
  if (!entities?.length || quoteLength <= 0) {
    return undefined;
  }
  const sliced: TelegramTextEntity[] = [];
  for (const entity of entities) {
    const offset = Number.isFinite(entity.offset) ? Math.trunc(entity.offset) : 0;
    const length = Number.isFinite(entity.length) ? Math.trunc(entity.length) : 0;
    const start = Math.max(0, offset);
    const end = Math.min(quoteLength, offset + length);
    if (end <= start) {
      continue;
    }
    sliced.push({
      ...entity,
      offset: start,
      length: end - start,
    });
  }
  return sliced.length > 0 ? sliced : undefined;
}

export function buildTelegramNativeQuoteCandidate(params: {
  text?: string;
  entities?: readonly TelegramTextEntity[];
  maxLength?: number;
}): TelegramNativeQuoteCandidate | undefined {
  const source = params.text;
  if (!source?.trim()) {
    return undefined;
  }
  const maxLength = params.maxLength ?? TELEGRAM_NATIVE_QUOTE_MAX_LENGTH;
  const text = truncateUtf16Safe(source, maxLength);
  if (!text.trim()) {
    return undefined;
  }
  const candidate: TelegramNativeQuoteCandidate = {
    text,
    position: 0,
  };
  const entities = sliceTelegramEntitiesForQuote(params.entities, text.length);
  if (entities) {
    candidate.entities = entities;
  }
  return candidate;
}

export function addTelegramNativeQuoteCandidate(
  target: TelegramNativeQuoteCandidateByMessageId,
  messageId: string | number | undefined,
  candidate: TelegramNativeQuoteCandidate | undefined,
): void {
  if (messageId == null || !candidate) {
    return;
  }
  const key = String(messageId).trim();
  if (!key || target[key]) {
    return;
  }
  target[key] = candidate;
}
