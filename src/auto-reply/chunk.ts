// Utilities for splitting outbound text into platform-sized chunks without
// unintentionally breaking on newlines. Using [\s\S] keeps newlines inside
// the chunk so messages are only split when they truly exceed the limit.

import type { ChannelId } from "../channels/plugins/types.js";
import type { MoltbotConfig } from "../config/config.js";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "../markdown/fences.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

export type TextChunkProvider = ChannelId | typeof INTERNAL_MESSAGE_CHANNEL;

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
  accounts?: Record<string, { textChunkLimit?: number; chunkMode?: ChunkMode }>;
};

function resolveChunkLimitForProvider(
  cfgSection: ProviderChunkConfig | undefined,
  accountId?: string | null,
): number | undefined {
  if (!cfgSection) return undefined;
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = cfgSection.accounts;
  if (accounts && typeof accounts === "object") {
    const direct = accounts[normalizedAccountId];
    if (typeof direct?.textChunkLimit === "number") {
      return direct.textChunkLimit;
    }
    const matchKey = Object.keys(accounts).find(
      (key) => key.toLowerCase() === normalizedAccountId.toLowerCase(),
    );
    const match = matchKey ? accounts[matchKey] : undefined;
    if (typeof match?.textChunkLimit === "number") {
      return match.textChunkLimit;
    }
  }
  return cfgSection.textChunkLimit;
}

export function resolveTextChunkLimit(
  cfg: MoltbotConfig | undefined,
  provider?: TextChunkProvider,
  accountId?: string | null,
  opts?: { fallbackLimit?: number },
): number {
  const fallback =
    typeof opts?.fallbackLimit === "number" && opts.fallbackLimit > 0
      ? opts.fallbackLimit
      : DEFAULT_CHUNK_LIMIT;
  const providerOverride = (() => {
    if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) return undefined;
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
  if (!cfgSection) return undefined;
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = cfgSection.accounts;
  if (accounts && typeof accounts === "object") {
    const direct = accounts[normalizedAccountId];
    if (direct?.chunkMode) {
      return direct.chunkMode;
    }
    const matchKey = Object.keys(accounts).find(
      (key) => key.toLowerCase() === normalizedAccountId.toLowerCase(),
    );
    const match = matchKey ? accounts[matchKey] : undefined;
    if (match?.chunkMode) {
      return match.chunkMode;
    }
  }
  return cfgSection.chunkMode;
}

export function resolveChunkMode(
  cfg: MoltbotConfig | undefined,
  provider?: TextChunkProvider,
  accountId?: string | null,
): ChunkMode {
  if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) return DEFAULT_CHUNK_MODE;
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
  if (!text) return [];
  if (maxLineLength <= 0) return text.trim() ? [text] : [];
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

    const firstLimit = Math.max(1, maxLineLength - prefix.length);
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
  if (!text) return [];
  if (limit <= 0) return [text];
  const splitLongParagraphs = opts?.splitLongParagraphs !== false;

  // Normalize to \n so blank line detection is consistent.
  const normalized = text.replace(/\r\n?/g, "\n");

  // Fast-path: if there are no blank-line paragraph separators, do not split.
  // (We *do not* early-return based on `limit` — newline mode is about paragraph
  // boundaries, not only exceeding a length limit.)
  const paragraphRe = /\n[\t ]*\n+/;
  if (!paragraphRe.test(normalized)) {
    if (normalized.length <= limit) return [normalized];
    if (!splitLongParagraphs) return [normalized];
    return chunkText(normalized, limit);
  }

  const spans = parseFenceSpans(normalized);

  const parts: string[] = [];
  const re = /\n[\t ]*\n+/g; // paragraph break: blank line(s), allowing whitespace
  let lastIndex = 0;
  for (const match of normalized.matchAll(re)) {
    const idx = match.index ?? 0;

    // Do not split on blank lines that occur inside fenced code blocks.
    if (!isSafeFenceBreak(spans, idx)) {
      continue;
    }

    parts.push(normalized.slice(lastIndex, idx));
    lastIndex = idx + match[0].length;
  }
  parts.push(normalized.slice(lastIndex));

  const chunks: string[] = [];
  for (const part of parts) {
    const paragraph = part.replace(/\s+$/g, "");
    if (!paragraph.trim()) continue;
    if (paragraph.length <= limit) {
      chunks.push(paragraph);
    } else if (!splitLongParagraphs) {
      chunks.push(paragraph);
    } else {
      chunks.push(...chunkText(paragraph, limit));
    }
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
    for (const chunk of paragraphChunks) {
      const nested = chunkMarkdownText(chunk, limit);
      if (!nested.length && chunk) out.push(chunk);
      else out.push(...nested);
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

export function chunkText(text: string, limit: number): string[] {
  if (!text) return [];
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // 1) Prefer a newline break inside the window (outside parentheses).
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window);

    // 2) Otherwise prefer the last whitespace (word boundary) inside the window.
    let breakIdx = lastNewline > 0 ? lastNewline : lastWhitespace;

    // 3) Fallback: hard break exactly at the limit.
    if (breakIdx <= 0) breakIdx = limit;

    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // If we broke on whitespace/newline, skip that separator; for hard breaks keep it.
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }

  if (remaining.length) chunks.push(remaining);

  return chunks;
}

export function chunkMarkdownText(text: string, limit: number): string[] {
  if (!text) return [];
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const spans = parseFenceSpans(remaining);
    const window = remaining.slice(0, limit);

    const softBreak = pickSafeBreakIndex(window, spans);
    let breakIdx = softBreak > 0 ? softBreak : limit;

    const initialFence = isSafeFenceBreak(spans, breakIdx)
      ? undefined
      : findFenceSpanAt(spans, breakIdx);

    let fenceToSplit = initialFence;
    if (initialFence) {
      const closeLine = `${initialFence.indent}${initialFence.marker}`;
      const maxIdxIfNeedNewline = limit - (closeLine.length + 1);

      if (maxIdxIfNeedNewline <= 0) {
        fenceToSplit = undefined;
        breakIdx = limit;
      } else {
        const minProgressIdx = Math.min(
          remaining.length,
          initialFence.start + initialFence.openLine.length + 2,
        );
        const maxIdxIfAlreadyNewline = limit - closeLine.length;

        let pickedNewline = false;
        let lastNewline = remaining.lastIndexOf("\n", Math.max(0, maxIdxIfAlreadyNewline - 1));
        while (lastNewline !== -1) {
          const candidateBreak = lastNewline + 1;
          if (candidateBreak < minProgressIdx) break;
          const candidateFence = findFenceSpanAt(spans, candidateBreak);
          if (candidateFence && candidateFence.start === initialFence.start) {
            breakIdx = Math.max(1, candidateBreak);
            pickedNewline = true;
            break;
          }
          lastNewline = remaining.lastIndexOf("\n", lastNewline - 1);
        }

        if (!pickedNewline) {
          if (minProgressIdx > maxIdxIfAlreadyNewline) {
            fenceToSplit = undefined;
            breakIdx = limit;
          } else {
            breakIdx = Math.max(minProgressIdx, maxIdxIfNeedNewline);
          }
        }
      }

      const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
      fenceToSplit =
        fenceAtBreak && fenceAtBreak.start === initialFence.start ? fenceAtBreak : undefined;
    }

    let rawChunk = remaining.slice(0, breakIdx);
    if (!rawChunk) break;

    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    let next = remaining.slice(nextStart);

    if (fenceToSplit) {
      const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
      rawChunk = rawChunk.endsWith("\n") ? `${rawChunk}${closeLine}` : `${rawChunk}\n${closeLine}`;
      next = `${fenceToSplit.openLine}\n${next}`;
    } else {
      next = stripLeadingNewlines(next);
    }

    chunks.push(rawChunk);
    remaining = next;
  }

  if (remaining.length) chunks.push(remaining);
  return chunks;
}

function stripLeadingNewlines(value: string): string {
  let i = 0;
  while (i < value.length && value[i] === "\n") i++;
  return i > 0 ? value.slice(i) : value;
}

function pickSafeBreakIndex(window: string, spans: ReturnType<typeof parseFenceSpans>): number {
  const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window, (index) =>
    isSafeFenceBreak(spans, index),
  );

  if (lastNewline > 0) return lastNewline;
  if (lastWhitespace > 0) return lastWhitespace;
  return -1;
}

function scanParenAwareBreakpoints(
  window: string,
  isAllowed: (index: number) => boolean = () => true,
): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;

  for (let i = 0; i < window.length; i++) {
    if (!isAllowed(i)) continue;
    const char = window[i];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (char === "\n") lastNewline = i;
    else if (/\s/.test(char)) lastWhitespace = i;
  }

  return { lastNewline, lastWhitespace };
}
