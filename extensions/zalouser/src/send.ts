import { createZalouserSendReceipt } from "./send-receipt.js";
import { parseZalouserTextStyles } from "./text-styles.js";
import type { ZaloEventMessage, ZaloSendOptions, ZaloSendResult } from "./types.js";
import {
  sendZaloDeliveredEvent,
  sendZaloLink,
  sendZaloReaction,
  sendZaloSeenEvent,
  sendZaloTextMessage,
  sendZaloTypingEvent,
} from "./zalo-js.js";
import { TextStyle } from "./zca-constants.js";

type ZalouserSendOptions = ZaloSendOptions;
type ZalouserSendResult = ZaloSendResult;

const ZALO_TEXT_LIMIT = 2000;
const DEFAULT_TEXT_CHUNK_MODE = "length";

type StyledTextChunk = {
  text: string;
  styles?: ZaloSendOptions["textStyles"];
};

type TextChunkMode = NonNullable<ZaloSendOptions["textChunkMode"]>;

export async function sendMessageZalouser(
  threadId: string,
  text: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  const prepared =
    options.textMode === "markdown"
      ? parseZalouserTextStyles(text)
      : { text, styles: options.textStyles };
  const textChunkLimit = options.textChunkLimit ?? ZALO_TEXT_LIMIT;
  const chunks = splitStyledText(
    prepared.text,
    (prepared.styles?.length ?? 0) > 0 ? prepared.styles : undefined,
    textChunkLimit,
    options.textChunkMode,
  );

  let lastResult: ZalouserSendResult | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const chunkOptions =
      index === 0
        ? { ...options, textStyles: chunk.styles }
        : {
            ...options,
            caption: undefined,
            mediaLocalRoots: undefined,
            mediaUrl: undefined,
            textStyles: chunk.styles,
          };
    const result = await sendZaloTextMessage(threadId, chunk.text, chunkOptions);
    if (!result.ok) {
      return result;
    }
    lastResult = result;
  }

  return (
    lastResult ?? {
      ok: false,
      error: "No message content provided",
      receipt: createZalouserSendReceipt({ threadId, kind: "text" }),
    }
  );
}

export async function sendImageZalouser(
  threadId: string,
  imageUrl: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  return await sendMessageZalouser(threadId, options.caption ?? "", {
    ...options,
    caption: undefined,
    mediaUrl: imageUrl,
  });
}

export async function sendLinkZalouser(
  threadId: string,
  url: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  return await sendZaloLink(threadId, url, options);
}

export async function sendTypingZalouser(
  threadId: string,
  options: Pick<ZalouserSendOptions, "profile" | "isGroup"> = {},
): Promise<void> {
  await sendZaloTypingEvent(threadId, options);
}

export async function sendReactionZalouser(params: {
  threadId: string;
  msgId: string;
  cliMsgId: string;
  emoji: string;
  remove?: boolean;
  profile?: string;
  isGroup?: boolean;
}): Promise<ZalouserSendResult> {
  const result = await sendZaloReaction({
    profile: params.profile,
    threadId: params.threadId,
    isGroup: params.isGroup,
    msgId: params.msgId,
    cliMsgId: params.cliMsgId,
    emoji: params.emoji,
    remove: params.remove,
  });
  return {
    ok: result.ok,
    error: result.error,
    receipt: createZalouserSendReceipt({ threadId: params.threadId, kind: "unknown" }),
  };
}

export async function sendDeliveredZalouser(params: {
  profile?: string;
  isGroup?: boolean;
  message: ZaloEventMessage;
  isSeen?: boolean;
}): Promise<void> {
  await sendZaloDeliveredEvent(params);
}

export async function sendSeenZalouser(params: {
  profile?: string;
  isGroup?: boolean;
  message: ZaloEventMessage;
}): Promise<void> {
  await sendZaloSeenEvent(params);
}

function splitStyledText(
  text: string,
  styles: ZaloSendOptions["textStyles"],
  limit: number,
  mode: ZaloSendOptions["textChunkMode"],
): StyledTextChunk[] {
  if (text.length === 0) {
    return [{ text, styles: undefined }];
  }

  const chunks: StyledTextChunk[] = [];
  for (const range of splitTextRanges(text, limit, mode ?? DEFAULT_TEXT_CHUNK_MODE)) {
    const { start, end } = range;
    chunks.push({
      text: text.slice(start, end),
      styles: sliceTextStyles(styles, start, end),
    });
  }
  return chunks;
}

function sliceTextStyles(
  styles: ZaloSendOptions["textStyles"],
  start: number,
  end: number,
): ZaloSendOptions["textStyles"] {
  if (!styles || styles.length === 0) {
    return undefined;
  }

  const chunkStyles = styles
    .map((style) => {
      const overlapStart = Math.max(style.start, start);
      const overlapEnd = Math.min(style.start + style.len, end);
      if (overlapEnd <= overlapStart) {
        return null;
      }

      if (style.st === TextStyle.Indent) {
        return {
          start: overlapStart - start,
          len: overlapEnd - overlapStart,
          st: style.st,
          indentSize: style.indentSize,
        };
      }

      return {
        start: overlapStart - start,
        len: overlapEnd - overlapStart,
        st: style.st,
      };
    })
    .filter((style): style is NonNullable<typeof style> => style !== null);

  return chunkStyles.length > 0 ? chunkStyles : undefined;
}

function splitTextRanges(
  text: string,
  limit: number,
  mode: TextChunkMode,
): Array<{ start: number; end: number }> {
  if (mode === "newline") {
    return splitTextRangesByPreferredBreaks(text, limit);
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < text.length; start += limit) {
    ranges.push({
      start,
      end: Math.min(text.length, start + limit),
    });
  }
  return ranges;
}

function splitTextRangesByPreferredBreaks(
  text: string,
  limit: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;

  while (start < text.length) {
    const maxEnd = Math.min(text.length, start + limit);
    let end = maxEnd;
    if (maxEnd < text.length) {
      end =
        findParagraphBreak(text, start, maxEnd) ??
        findLastBreak(text, "\n", start, maxEnd) ??
        findLastWhitespaceBreak(text, start, maxEnd) ??
        maxEnd;
    }

    if (end <= start) {
      end = maxEnd;
    }

    ranges.push({ start, end });
    start = end;
  }

  return ranges;
}

function findParagraphBreak(text: string, start: number, end: number): number | undefined {
  const slice = text.slice(start, end);
  const matches = slice.matchAll(/\n[\t ]*\n+/g);
  let lastMatch: RegExpMatchArray | undefined;
  for (const match of matches) {
    lastMatch = match;
  }
  if (!lastMatch || lastMatch.index === undefined) {
    return undefined;
  }
  return start + lastMatch.index + lastMatch[0].length;
}

function findLastBreak(
  text: string,
  marker: string,
  start: number,
  end: number,
): number | undefined {
  const index = text.lastIndexOf(marker, end - 1);
  if (index < start) {
    return undefined;
  }
  return index + marker.length;
}

function findLastWhitespaceBreak(text: string, start: number, end: number): number | undefined {
  for (let index = end - 1; index > start; index -= 1) {
    if (/\s/.test(text[index])) {
      return index + 1;
    }
  }
  return undefined;
}
