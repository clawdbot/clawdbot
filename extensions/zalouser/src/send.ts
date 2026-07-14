// Zalouser plugin module implements send behavior.
import { chunkTextRanges } from "openclaw/plugin-sdk/text-chunking";
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

type ZalouserSendOptions = ZaloSendOptions & {
  /** Persist each concrete platform send before the next internal chunk starts. */
  onDeliveryResult?: (result: ZaloSendResult) => Promise<void> | void;
};
type ZalouserSendResult = ZaloSendResult;

const ZALO_TEXT_LIMIT = 2000;

type StyledTextChunk = {
  text: string;
  styles?: ZaloSendOptions["textStyles"];
};

export async function sendMessageZalouser(
  threadId: string,
  text: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  const { onDeliveryResult, ...transportOptions } = options;
  const prepared =
    transportOptions.textMode === "markdown"
      ? parseZalouserTextStyles(text)
      : { text, styles: transportOptions.textStyles };
  const textChunkLimit = transportOptions.textChunkLimit ?? ZALO_TEXT_LIMIT;
  const chunks = splitStyledText(
    prepared.text,
    (prepared.styles?.length ?? 0) > 0 ? prepared.styles : undefined,
    textChunkLimit,
    transportOptions.textChunkMode,
  );

  let lastResult: ZalouserSendResult | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const chunkOptions =
      index === 0
        ? { ...transportOptions, textStyles: chunk.styles }
        : {
            ...transportOptions,
            caption: undefined,
            mediaLocalRoots: undefined,
            mediaUrl: undefined,
            textStyles: chunk.styles,
          };
    const result = await sendZaloTextMessage(threadId, chunk.text, chunkOptions);
    if (!result.ok) {
      throw new Error(result.error || "Failed to send Zalouser message");
    }
    await onDeliveryResult?.(result);
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
  for (const range of chunkTextRanges(text, {
    limit,
    mode: mode === "newline" ? "preferred" : "hard",
  })) {
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
