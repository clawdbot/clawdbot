import type { OutboundDeliveryFormattingOptions } from "openclaw/plugin-sdk/channel-outbound";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { findCodeRegions } from "openclaw/plugin-sdk/text-chunking";

/** Keep inbound replies aligned with the existing Synology outbound transport cap. */
export const SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT = 2_000;

export const SYNOLOGY_MARKDOWN_LINK_RE =
  /(?<!!)\[((?:\\[^\n]|[^\\\]\n])+)\]\((https?:\/\/(?:\\[^\n]|[^()\s<>\\])+(?:\((?:\\[^\n]|[^()\s<>\\])*\)(?:\\[^\n]|[^()\s<>\\])*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\)/g;

export function chunkSynologyChatText(
  text: string,
  limit = SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT,
  context?: { formatting?: OutboundDeliveryFormattingOptions },
): string[] {
  const chunks: string[] = [];
  const codeRegions = findCodeRegions(text);
  const chunkMode = context?.formatting?.chunkMode ?? "length";
  let pending = "";
  let pendingContainsLink = false;
  let cursor = 0;

  const appendText = (next: string): void => {
    if (pendingContainsLink && pending.length + next.length > limit) {
      chunks.push(pending);
      pending = "";
      pendingContainsLink = false;
    }
    const nextChunks = chunkMarkdownTextWithMode(`${pending}${next}`, limit, chunkMode);
    chunks.push(...nextChunks.slice(0, -1));
    pending = nextChunks.at(-1) ?? "";
    if (nextChunks.length > 1) {
      pendingContainsLink = false;
    }
  };

  const appendAtomic = (value: string): void => {
    if (value.length > limit) {
      appendText(value);
      return;
    }
    if (pending.length + value.length > limit) {
      if (pending) {
        chunks.push(pending);
      }
      pending = value;
    } else {
      pending += value;
    }
    pendingContainsLink = true;
  };

  // Links must stay with their escapes or code delimiters; rendering a
  // context-free fragment would incorrectly turn literal text into a link.
  for (const match of text.matchAll(SYNOLOGY_MARKDOWN_LINK_RE)) {
    const offset = match.index;
    if (offset < cursor) {
      continue;
    }

    const codeRegion = codeRegions.find((region) => offset >= region.start && offset < region.end);
    if (codeRegion) {
      appendText(text.slice(cursor, codeRegion.start));
      const code = text.slice(codeRegion.start, codeRegion.end);
      const marker = code.match(/^`+/)?.[0];
      const isFencedCode = /^`{3,}[^\r\n]*\r?\n/u.test(code);
      if (marker && !isFencedCode && code.endsWith(marker) && code.length > limit) {
        const contentLimit = limit - marker.length * 2;
        if (contentLimit > 0) {
          const content = code.slice(marker.length, -marker.length);
          for (const part of chunkMarkdownTextWithMode(content, contentLimit, chunkMode)) {
            appendAtomic(`${marker}${part}${marker}`);
          }
        } else {
          appendText(code);
        }
      } else {
        appendAtomic(code);
      }
      cursor = codeRegion.end;
      continue;
    }

    const escapes = text.slice(cursor, offset).match(/\\+$/)?.[0] ?? "";
    const linkStart = offset - escapes.length;
    appendText(text.slice(cursor, linkStart));
    appendAtomic(`${escapes}${match[0]}`);
    cursor = offset + match[0].length;
  }

  appendText(text.slice(cursor));
  if (pending) {
    chunks.push(pending);
  }
  return chunks;
}
