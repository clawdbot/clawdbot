// Utilities for splitting outbound text into platform-sized chunks without
// unintentionally breaking on newlines. Using [\s\S] keeps newlines inside
// the chunk so messages are only split when they truly exceed the limit.

import type { ClawdbotConfig } from "../config/config.js";
import {
  findFenceSpanAt,
  isSafeFenceBreak,
  parseFenceSpans,
} from "../markdown/fences.js";
import type { ProviderId } from "../providers/plugins/types.js";
import { normalizeAccountId } from "../routing/session-key.js";

export type TextChunkProvider = ProviderId | "webchat";

const DEFAULT_CHUNK_LIMIT = 4000;
const DEFAULT_CHUNK_LIMIT_BY_PROVIDER: Partial<Record<ProviderId, number>> = {
  discord: 2000,
};

type ProviderChunkConfig = {
  textChunkLimit?: number;
  accounts?: Record<string, { textChunkLimit?: number }>;
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
  cfg: ClawdbotConfig | undefined,
  provider?: TextChunkProvider,
  accountId?: string | null,
): number {
  const providerOverride = (() => {
    if (!provider || provider === "webchat") return undefined;
    const providerConfig = (cfg as Record<string, unknown> | undefined)?.[
      provider
    ] as ProviderChunkConfig | undefined;
    return resolveChunkLimitForProvider(providerConfig, accountId);
  })();
  if (typeof providerOverride === "number" && providerOverride > 0) {
    return providerOverride;
  }
  if (provider && provider !== "webchat") {
    return DEFAULT_CHUNK_LIMIT_BY_PROVIDER[provider] ?? DEFAULT_CHUNK_LIMIT;
  }
  return DEFAULT_CHUNK_LIMIT;
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
    const brokeOnSeparator =
      breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(
      remaining.length,
      breakIdx + (brokeOnSeparator ? 1 : 0),
    );
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
        let lastNewline = remaining.lastIndexOf(
          "\n",
          Math.max(0, maxIdxIfAlreadyNewline - 1),
        );
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
        fenceAtBreak && fenceAtBreak.start === initialFence.start
          ? fenceAtBreak
          : undefined;
    }

    let rawChunk = remaining.slice(0, breakIdx);
    if (!rawChunk) break;

    const brokeOnSeparator =
      breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(
      remaining.length,
      breakIdx + (brokeOnSeparator ? 1 : 0),
    );
    let next = remaining.slice(nextStart);

    if (fenceToSplit) {
      const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
      rawChunk = rawChunk.endsWith("\n")
        ? `${rawChunk}${closeLine}`
        : `${rawChunk}\n${closeLine}`;
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

function pickSafeBreakIndex(
  window: string,
  spans: ReturnType<typeof parseFenceSpans>,
): number {
  const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(
    window,
    (index) => isSafeFenceBreak(spans, index),
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
