import { InputFile } from "grammy";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { extensionForMime, type MediaKind } from "openclaw/plugin-sdk/media-mime";
import { isGifMedia, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { resolveTelegramPlainCaption, splitTelegramCaption } from "./caption.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import type { TelegramOutboundPromptContextMessage } from "./outbound-message-context.js";
import { isTelegramHtmlParseError } from "./rich-plain-fallback.js";
import type { TelegramApi } from "./send-context.js";
import { isTelegramPhotoLimitError } from "./send-error-predicates.js";
import { resolveTelegramVoiceSend } from "./voice.js";

type TelegramLoadedMedia = Awaited<ReturnType<typeof loadWebMedia>>;

type TelegramOutboundMediaKind =
  | "animation"
  | "photo"
  | "video"
  | "video_note"
  | "voice"
  | "audio"
  | "document";

type TelegramOutboundMediaPlan = {
  kind: MediaKind | undefined;
  deliveryKind: MediaKind | undefined;
  isGif: boolean;
  isVideoNote: boolean;
  fileName: string;
  file: InputFile;
  caption?: string;
  htmlCaption?: string;
  plainCaption?: string;
  followUpText?: string;
};

export type TelegramOutboundMediaSender<T = TelegramOutboundPromptContextMessage> = {
  label: TelegramOutboundMediaKind;
  operation: string;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
};

function resolveTelegramOutboundMediaFilename(params: {
  fileName?: string;
  contentType?: string;
  kind?: MediaKind;
  isGif: boolean;
}): string {
  if (params.fileName) {
    return params.fileName;
  }
  if (params.isGif) {
    return "animation.gif";
  }

  // Telegram receives only the multipart filename, so preserve the detected
  // MIME extension instead of labeling every anonymous upload as another format.
  const basename =
    params.kind === "image" || params.kind === "video" || params.kind === "audio"
      ? params.kind
      : "file";
  const defaultExtension =
    params.kind === "image"
      ? ".jpg"
      : params.kind === "video"
        ? ".mp4"
        : params.kind === "audio"
          ? ".ogg"
          : ".bin";
  return `${basename}${extensionForMime(params.contentType) ?? defaultExtension}`;
}

export function prepareTelegramOutboundMedia(params: {
  media: TelegramLoadedMedia;
  text?: string;
  textMode?: "markdown" | "html";
  tableMode?: MarkdownTableMode;
  forceDocument?: boolean;
  asVideoNote?: boolean;
  preparedHtml?: boolean;
}): TelegramOutboundMediaPlan {
  const kind = kindFromMime(params.media.contentType ?? undefined);
  const isGif = isGifMedia({
    contentType: params.media.contentType,
    fileName: params.media.fileName,
  });
  const deliveryKind =
    params.forceDocument === true && (kind === "image" || kind === "video") ? "document" : kind;
  if (params.asVideoNote === true && deliveryKind !== "video") {
    throw new Error("Telegram video notes require video media.");
  }
  const isVideoNote = deliveryKind === "video" && params.asVideoNote === true;
  const fileName = resolveTelegramOutboundMediaFilename({
    fileName: params.media.fileName,
    contentType: params.media.contentType,
    kind,
    isGif,
  });
  const text = params.text;
  const trimmedText = text?.trim();
  const renderedCaption =
    !isVideoNote && trimmedText
      ? params.preparedHtml === true && params.textMode === "html"
        ? trimmedText
        : renderTelegramHtmlText(trimmedText, {
            textMode: params.textMode ?? "markdown",
            tableMode: params.tableMode,
          })
      : undefined;
  const { caption, followUpText } = isVideoNote
    ? { caption: undefined, followUpText: trimmedText ? text : undefined }
    : splitTelegramCaption(text, renderedCaption);
  const htmlCaption = caption ? renderedCaption : undefined;

  return {
    kind,
    deliveryKind,
    isGif,
    isVideoNote,
    fileName,
    file: new InputFile(params.media.buffer, fileName),
    caption,
    htmlCaption,
    plainCaption: resolveTelegramPlainCaption(
      caption && params.textMode === "html" ? telegramHtmlToPlainTextFallback(caption) : caption,
      htmlCaption,
    ),
    followUpText,
  };
}

export function resolveTelegramOutboundMediaSenders<
  T = TelegramOutboundPromptContextMessage,
>(params: {
  api: TelegramApi;
  chatId: string;
  media: TelegramLoadedMedia;
  plan: TelegramOutboundMediaPlan;
  forceDocument?: boolean;
  asVoice?: boolean;
  sendImageAsPhoto?: boolean;
}): { sender: TelegramOutboundMediaSender<T>; documentSender: TelegramOutboundMediaSender<T> } {
  const createSender = (label: TelegramOutboundMediaKind): TelegramOutboundMediaSender<T> => {
    const operation = `send${label
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("")}`;
    const method = params.api[operation as keyof TelegramApi] as unknown as (
      chatId: string,
      file: InputFile,
      options: Record<string, unknown>,
    ) => Promise<T>;
    return {
      label,
      operation,
      send: (effectiveParams) =>
        method.call(
          params.api,
          params.chatId,
          params.plan.file,
          label === "document" && params.forceDocument
            ? { ...effectiveParams, disable_content_type_detection: true }
            : effectiveParams,
        ),
    };
  };
  const documentSender = createSender("document");
  let label: TelegramOutboundMediaKind = "document";
  if (params.plan.isGif && params.plan.deliveryKind !== "document") {
    label = "animation";
  } else if (
    params.plan.deliveryKind === "image" &&
    !params.plan.isGif &&
    params.sendImageAsPhoto !== false
  ) {
    label = "photo";
  } else if (params.plan.deliveryKind === "video") {
    label = params.plan.isVideoNote ? "video_note" : "video";
  } else if (params.plan.kind === "audio") {
    const { useVoice } = resolveTelegramVoiceSend({
      wantsVoice: params.asVoice === true,
      contentType: params.media.contentType,
      fileName: params.plan.fileName,
      logFallback: logVerbose,
    });
    label = useVoice ? "voice" : "audio";
  }
  return { sender: label === "document" ? documentSender : createSender(label), documentSender };
}

export async function sendTelegramCaptionedMediaWithFallback<T>(params: {
  operation: string;
  requestParams: Record<string, unknown>;
  plainCaption?: string;
  shouldLog?: (err: unknown) => boolean;
  send: (
    requestParams: Record<string, unknown>,
    shouldLog?: (err: unknown) => boolean,
  ) => Promise<T>;
}): Promise<T> {
  if (!params.plainCaption) {
    return await params.send(params.requestParams, params.shouldLog);
  }
  try {
    return await params.send(
      params.requestParams,
      (err) => !isTelegramHtmlParseError(err) && (params.shouldLog?.(err) ?? true),
    );
  } catch (err) {
    if (!isTelegramHtmlParseError(err)) {
      throw err;
    }
    // Captions share the text-send contract: retain visible content after an
    // HTML parse failure without disturbing the topic, quote, or keyboard.
    logVerbose(
      `telegram ${params.operation} caption HTML rejected; retrying as plain caption: ${formatErrorMessage(
        err,
      )}`,
    );
    const plainParams: Record<string, unknown> = {
      ...params.requestParams,
      caption: params.plainCaption,
    };
    delete plainParams.parse_mode;
    return await params.send(plainParams, params.shouldLog);
  }
}

export async function sendTelegramOutboundMediaWithPhotoFallback<T, TMessage>(params: {
  sender: TelegramOutboundMediaSender<TMessage>;
  documentSender: TelegramOutboundMediaSender<TMessage>;
  send: (sender: TelegramOutboundMediaSender<TMessage>) => Promise<T>;
}): Promise<{ result: T; sender: TelegramOutboundMediaSender<TMessage> }> {
  try {
    return { result: await params.send(params.sender), sender: params.sender };
  } catch (error) {
    if (params.sender.label !== "photo" || !isTelegramPhotoLimitError(error)) {
      throw error;
    }
    // Telegram is authoritative for photo limits; preserve the same bytes and
    // accepted caption/topic/quote/keyboard when retrying as a document.
    logVerbose(
      `telegram sendPhoto exceeded photo limits; retrying as document: ${formatErrorMessage(error)}`,
    );
    return { result: await params.send(params.documentSender), sender: params.documentSender };
  }
}
