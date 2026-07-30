// Telegram plugin module implements bot handlers.media behavior.
import type { Message } from "grammy/types";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

const TELEGRAM_BOT_API_FILE_DOWNLOAD_LIMIT_MB = 20;

export class TelegramBotApiFileTooLargeError extends MediaFetchError {
  readonly limitMb = TELEGRAM_BOT_API_FILE_DOWNLOAD_LIMIT_MB;

  constructor(cause: unknown) {
    super(
      "max_bytes",
      `Telegram Bot API cannot download files larger than ${TELEGRAM_BOT_API_FILE_DOWNLOAD_LIMIT_MB} MB`,
      { cause, status: 400 },
    );
    this.name = "TelegramBotApiFileTooLargeError";
  }
}

export function isMediaSizeLimitError(err: unknown): boolean {
  if (err instanceof TelegramBotApiFileTooLargeError) {
    return true;
  }
  const errMsg = String(err);
  return errMsg.includes("exceeds") && errMsg.includes("MB limit");
}

export function isRecoverableMediaGroupError(err: unknown): boolean {
  return err instanceof MediaFetchError || isMediaSizeLimitError(err);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if ("name" in err && err.name === "AbortError") {
    return true;
  }
  return "message" in err && err.message === "This operation was aborted";
}

export function isDurablyRetryableInboundMediaError(err: unknown): boolean {
  if (!(err instanceof MediaFetchError)) {
    return false;
  }
  if (err.code === "http_error") {
    return (
      typeof err.status === "number" &&
      (err.status === 408 || err.status === 429 || err.status >= 500)
    );
  }
  if (err.code !== "fetch_failed") {
    return false;
  }
  return (
    isAbortError(err) ||
    isAbortError(err.cause) ||
    isRecoverableTelegramNetworkError(err, { context: "polling" })
  );
}

export function hasInboundMedia(msg: Message): boolean {
  return (
    Boolean(msg.media_group_id) ||
    (Array.isArray(msg.photo) && msg.photo.length > 0) ||
    Boolean(msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice ?? msg.sticker)
  );
}

export function resolveInboundMediaFileId(msg: Message): string | undefined {
  return (
    msg.sticker?.file_id ??
    msg.photo?.[msg.photo.length - 1]?.file_id ??
    msg.video?.file_id ??
    msg.video_note?.file_id ??
    msg.document?.file_id ??
    msg.audio?.file_id ??
    msg.voice?.file_id
  );
}
