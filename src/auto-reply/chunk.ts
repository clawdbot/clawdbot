// Utilities for splitting outbound text into platform-sized chunks without
// unintentionally breaking on newlines. Using [\s\S] keeps newlines inside
// the chunk so messages are only split when they truly exceed the limit.

import {
  findFenceSpanAt,
  isSafeFenceBreak,
  parseFenceSpans,
} from "../../packages/markdown-core/src/fences.js";
import type { ChannelId } from "../channels/plugins/types.core.js";
import { resolveChannelStreamingChunkMode } from "../channels/streaming.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import {
  avoidTrailingHighSurrogateBreak,
  chunkTextByBreakResolver,
} from "../shared/text-chunking.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";

export type TextChunkProvider = ChannelId;

/**
 * Chunking mode for outbound messages:
 * - "length": Split only when exceeding textChunkLimit (default)
 * - "newline": Prefer breaking on "soft" boundaries. Historically this split on every
 *   newline; now it only breaks on paragraph boundaries (blank lines) unless the text
 *   exceeds the length limit.
 */
export type ChunkMode = "length" | "newline";

const DEFAULT_CHUNK_LIMIT = 4000;
const DEFAULT_CHUNK_MODE: ChunkMode = "length";

type ProviderChunkConfig = {
  textChunkLimit?: number;
  chunkMode?: ChunkMode;
  streaming?: unknown;
  accounts?: Record<
    string,
    { textChunkLimit?: number; chunkMode?: ChunkMode; streaming?: unknown }
  >;
};

function resolveChunkLimitForProvider(
  cfgSection: ProviderChunkConfig | undefined,
  accountId?: string | null,
): number | undefined {
  if (!cfgSection) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = cfgSection.accounts;
  if (accounts && typeof accounts === "object") {
    const direct = resolveAccountEntry(accounts, normalizedAccountId);
    if (typeof direct?.textChunkLimit === "number") {
      return direct.textChunkLimit;
    }
  }
  return cfgSection.textChunkLimit;
}

export function resolveTextChunkLimit(
  cfg: OpenClawConfig | undefined,
  provider?: TextChunkProvider,
  accountId?: string | null,
  opts?: { fallbackLimit?: number },
): number {
  const fallback =
    typeof opts?.fallbackLimit === "number" && opts.fallbackLimit > 0
      ? opts.fallbackLimit
      : DEFAULT_CHUNK_LIMIT;
  const providerOverride = (() => {
    if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) {
      return undefined;
    }
    const channelsConfig = cfg?.channels as Record<string, unknown> | undefined;
    const providerConfig = (channelsConfig?.[provider] ??
      (cfg as Record<string, unknown> | undefined)?.[provider]) as ProviderChunkConfig | undefined;
    return resolveChunkLimitForProvider(providerConfig, accountId);
  })();
  if (typeof providerOverride === "number" && providerOverride > 0) {
    return providerOverride;
  }
  return fallback;
}

function resolveChunkModeForProvider(
  cfgSection: ProviderChunkConfig | undefined,
  accountId?: string | null,
): ChunkMode | undefined {
  if (!cfgSection) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = cfgSection.accounts;
  if (accounts && typeof accounts === "object") {
    const direct = resolveAccountEntry(accounts, normalizedAccountId);
    // resolveChannelStreamingChunkMode owns nested-first/flat-fallback
    // precedence (the flat `chunkMode` fallback serves external SDK plugin
    // configs during the deprecation window). Do not re-read flat keys here.
    const directMode = resolveChannelStreamingChunkMode(direct);
    if (directMode) {
      return directMode;
    }
  }
  return resolveChannelStreamingChunkMode(cfgSection);
}

export function resolveChunkMode(
  cfg: OpenClawConfig | undefined,
  provider?: TextChunkProvider,
  accountId?: string | null,
): ChunkMode {
  if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) {
    return DEFAULT_CHUNK_MODE;
  }
  const channelsConfig = cfg?.channels as Record<string, unknown> | undefined;
  const providerConfig = (channelsConfig?.[provider] ??
    (cfg as Record<string, unknown> | undefined)?.[provider]) as ProviderChunkConfig | undefined;
  const mode = resolveChunkModeForProvider(providerConfig, accountId);
  return mode ?? DEFAULT_CHUNK_MODE;
}

/**
 * Split text on newlines, trimming line whitespace.
 * Blank lines are folded into the next non-empty line as leading "\n" prefixes.
 * Long lines can be split by length (default) or kept intact via splitLongLines:false.
 */
export function chunkByNewline(
  text: string,
  maxLineLength: number,
  opts?: {
    splitLongLines?: boolean;
    trimLines?: boolean;
    isSafeBreak?: (index: number) => boolean;
  },
): string[] {
  if (!text) {
    return [];
  }
  if (maxLineLength <= 0) {
    return text.trim() ? [text] : [];
  }
  const splitLongLines = opts?.splitLongLines !== false;
  const trimLines = opts?.trimLines !== false;
  const lines = splitByNewline(text, opts?.isSafeBreak);
  const chunks: string[] = [];
  let pendingBlankLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      pendingBlankLines += 1;
      continue;
    }

    const maxPrefix = Math.max(0, maxLineLength - 1);
    const cappedBlankLines = pendingBlankLines > 0 ? Math.min(pendingBlankLines, maxPrefix) : 0;
    const prefix = cappedBlankLines > 0 ? "\n".repeat(cappedBlankLines) : "";
    pendingBlankLines = 0;

    const lineValue = trimLines ? trimmed : line;
    if (!splitLongLines || lineValue.length + prefix.length <= maxLineLength) {
      chunks.push(prefix + lineValue);
      continue;
    }

    // Back the head cut off to a code-point boundary so an over-long line never splits a surrogate
    // pair; the recursive chunkText below is already surrogate-safe, only this first cut was raw.
    const rawLimit = Math.max(1, maxLineLength - prefix.length);
    const firstLimit = avoidTrailingHighSurrogateBreak(lineValue, 0, rawLimit);
    const first = lineValue.slice(0, firstLimit);
    chunks.push(prefix + first);
    const remaining = lineValue.slice(firstLimit);
    if (remaining) {
      chunks.push(...chunkText(remaining, maxLineLength));
    }
  }

  if (pendingBlankLines > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] += "\n".repeat(pendingBlankLines);
  }

  return chunks;
}

/**
 * Split text into chunks on paragraph boundaries (blank lines), preserving lists and
 * single-newline line wraps inside paragraphs.
 *
 * - Only breaks at paragraph separators ("\n\n" or more, allowing whitespace on blank lines)
 * - Packs multiple paragraphs into a single chunk up to `limit`
 * - Falls back to length-based splitting when a single paragraph exceeds `limit`
 *   (unless `splitLongParagraphs` is disabled)
 */
export function chunkByParagraph(
  text: string,
  limit: number,
  opts?: { splitLongParagraphs?: boolean },
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  const splitLongParagraphs = opts?.splitLongParagraphs !== false;

  // Normalize to \n so blank line detection is consistent.
  const normalized = text.replace(/\r\n?/g, "\n");

  // Fast-path: if there are no blank-line paragraph separators, do not split.
  // (We *do not* early-return based on `limit` — newline mode is about paragraph
  // boundaries, not only exceeding a length limit.)
  const paragraphRe = /\n[\t ]*\n+/;
  if (!paragraphRe.test(normalized)) {
    if (normalized.length <= limit) {
      return [normalized];
    }
    if (!splitLongParagraphs) {
      return [normalized];
    }
    return chunkText(normalized, limit);
  }

  const spans = parseFenceSpans(normalized);

  const parts: string[] = [];
  const separators: string[] = [];
  const re = /\n[\t ]*\n+/g; // paragraph break: blank line(s), allowing whitespace
  let lastIndex = 0;
  for (const match of normalized.matchAll(re)) {
    const idx = match.index ?? 0;

    // Do not split on blank lines that occur inside fenced code blocks.
    if (!isSafeFenceBreak(spans, idx)) {
      continue;
    }

    parts.push(normalized.slice(lastIndex, idx));
    separators.push(match[0]);
    lastIndex = idx + match[0].length;
  }
  parts.push(normalized.slice(lastIndex));

  const chunks: string[] = [];
  let currentChunk = "";

  const pushParagraph = (paragraph: string, separatorBefore?: string) => {
    if (!currentChunk) {
      if (paragraph.length <= limit) {
        currentChunk = paragraph;
        return;
      }
      if (!splitLongParagraphs) {
        chunks.push(paragraph);
        return;
      }
      chunks.push(...chunkText(paragraph, limit));
      return;
    }

    const candidate = `${currentChunk}${separatorBefore ?? "\n\n"}${paragraph}`;
    if (candidate.length <= limit) {
      currentChunk = candidate;
      return;
    }

    chunks.push(currentChunk);
    currentChunk = "";
    pushParagraph(paragraph);
  };

  for (const [index, part] of parts.entries()) {
    const paragraph = part.replace(/\s+$/g, "");
    if (!paragraph.trim()) {
      continue;
    }
    pushParagraph(paragraph, separators[index - 1]);
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Unified chunking function that dispatches based on mode.
 */
export function chunkTextWithMode(text: string, limit: number, mode: ChunkMode): string[] {
  if (mode === "newline") {
    return chunkByParagraph(text, limit);
  }
  return chunkText(text, limit);
}

export function chunkMarkdownTextWithMode(text: string, limit: number, mode: ChunkMode): string[] {
  if (mode === "newline") {
    // Paragraph chunking is fence-safe because we never split at arbitrary indices.
    // If a paragraph must be split by length, defer to the markdown-aware chunker.
    const paragraphChunks = chunkByParagraph(text, limit, { splitLongParagraphs: false });
    const out: string[] = [];
    for (const chunk of paragraphChunks.flatMap((paragraphChunk) =>
      paragraphChunk.length > limit
        ? splitPackedFenceParagraphChunk(paragraphChunk)
        : paragraphChunk,
    )) {
      out.push(...chunkMarkdownText(chunk, limit));
    }
    return out;
  }
  return chunkMarkdownText(text, limit);
}

function splitByNewline(
  text: string,
  isSafeBreak: (index: number) => boolean = () => true,
): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && isSafeBreak(i)) {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

function splitPackedFenceParagraphChunk(chunk: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (const span of parseFenceSpans(chunk)) {
    if (span.end <= start) {
      continue;
    }
    const separator = chunk.slice(span.end).match(/^\n[\t ]*\n+/)?.[0];
    if (!separator) {
      continue;
    }
    const tail = chunk.slice(span.end + separator.length);
    if (!tail.trim()) {
      continue;
    }
    chunks.push(chunk.slice(start, span.end));
    start = span.end + separator.length;
  }
  if (chunks.length === 0) {
    return [chunk];
  }
  const tail = chunk.slice(start);
  if (tail) {
    chunks.push(tail);
  }
  return chunks;
}

function resolveChunkEarlyReturn(text: string, limit: number): string[] | undefined {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  if (text.length <= limit) {
    return [text];
  }
  return undefined;
}

export function chunkText(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) {
    return early;
  }
  return chunkTextByBreakResolver(text, limit, (window) => {
    // 1) Prefer a newline break inside the window (outside parentheses).
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window, 0, window.length);
    // 2) Otherwise prefer the last whitespace (word boundary) inside the window.
    return lastNewline > 0 ? lastNewline : lastWhitespace;
  });
}

export function chunkMarkdownText(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) {
    return early;
  }

  const chunks: string[] = [];
  const spans = parseFenceSpans(text);
  let start = 0;
  let reopenFence: ReturnType<typeof findFenceSpanAt> | undefined;

  while (start < text.length) {
    const reopenPrefix = reopenFence ? `${reopenFence.openLine}\n` : "";
    const contentLimit = Math.max(1, limit - reopenPrefix.length);
    if (text.length - start <= contentLimit) {
      const finalChunk = `${reopenPrefix}${text.slice(start)}`;
      if (finalChunk.length > 0) {
        chunks.push(finalChunk);
      }
      break;
    }

    const windowEnd = Math.min(text.length, start + contentLimit);
    const softBreak = pickSafeBreakIndex(text, start, windowEnd, spans);
    let breakIdx = softBreak > start ? softBreak : windowEnd;

    const initialFence = isSafeFenceBreak(spans, breakIdx)
      ? undefined
      : findFenceSpanAt(spans, breakIdx);

    let fenceToSplit = initialFence;
    if (initialFence) {
      const closeLine = `${initialFence.indent}${initialFence.marker}`;
      const maxIdxIfNeedNewline = start + (contentLimit - (closeLine.length + 1));

      if (maxIdxIfNeedNewline <= start) {
        breakIdx = windowEnd;
      } else {
        const minProgressIdx = Math.min(
          text.length,
          Math.max(start + 1, initialFence.start + initialFence.openLine.length + 2),
        );
        const maxIdxIfAlreadyNewline = start + (contentLimit - closeLine.length);

        let pickedNewline = false;
        let lastNewline = text.lastIndexOf("\n", Math.max(start, maxIdxIfAlreadyNewline - 1));
        while (lastNewline >= start) {
          const candidateBreak = lastNewline + 1;
          if (candidateBreak < minProgressIdx) {
            break;
          }
          const candidateFence = findFenceSpanAt(spans, candidateBreak);
          if (candidateFence && candidateFence.start === initialFence.start) {
            breakIdx = candidateBreak;
            pickedNewline = true;
            break;
          }
          lastNewline = text.lastIndexOf("\n", lastNewline - 1);
        }

        if (!pickedNewline) {
          if (minProgressIdx > maxIdxIfAlreadyNewline) {
            breakIdx = windowEnd;
          } else {
            breakIdx = Math.max(minProgressIdx, maxIdxIfNeedNewline);
          }
        }
      }

      const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
      fenceToSplit =
        fenceAtBreak && fenceAtBreak.start === initialFence.start ? fenceAtBreak : undefined;
    }

    const safeBreakIdx = avoidTrailingHighSurrogateBreak(text, start, breakIdx);
    if (safeBreakIdx !== breakIdx) {
      breakIdx = safeBreakIdx;
      if (fenceToSplit) {
        const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
        fenceToSplit =
          fenceAtBreak && fenceAtBreak.start === fenceToSplit.start ? fenceAtBreak : undefined;
      }
    }

    const rawContent = text.slice(start, breakIdx);
    if (!rawContent) {
      break;
    }

    let rawChunk = `${reopenPrefix}${rawContent}`;
    const brokeOnSeparator = breakIdx < text.length && /\s/.test(text.charAt(breakIdx));
    let nextStart = Math.min(text.length, breakIdx + (brokeOnSeparator ? 1 : 0));

    if (fenceToSplit) {
      const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
      rawChunk = rawChunk.endsWith("\n") ? `${rawChunk}${closeLine}` : `${rawChunk}\n${closeLine}`;
      reopenFence = fenceToSplit;
    } else {
      nextStart = skipLeadingNewlines(text, nextStart);
      reopenFence = undefined;
    }

    chunks.push(rawChunk);
    start = nextStart;
  }
  return chunks;
}

function skipLeadingNewlines(value: string, start = 0): number {
  let i = start;
  while (i < value.length && value[i] === "\n") {
    i++;
  }
  return i;
}

function pickSafeBreakIndex(
  text: string,
  start: number,
  end: number,
  spans: ReturnType<typeof parseFenceSpans>,
): number {
  const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(text, start, end, (index) =>
    isSafeFenceBreak(spans, index),
  );

  if (lastNewline > start) {
    return lastNewline;
  }
  if (lastWhitespace > start) {
    return lastWhitespace;
  }
  return -1;
}

function scanParenAwareBreakpoints(
  text: string,
  start: number,
  end: number,
  isAllowed: (index: number) => boolean = () => true,
): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;

  for (let i = start; i < end; i++) {
    if (!isAllowed(i)) {
      continue;
    }
    const char = text.charAt(i);
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === "\n") {
      lastNewline = i;
    } else if (/\s/.test(char)) {
      lastWhitespace = i;
    }
  }

  return { lastNewline, lastWhitespace };
}
