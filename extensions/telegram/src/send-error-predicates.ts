import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const TELEGRAM_CAPTION_TOO_LONG_RE = /caption is too long/i;
const TELEGRAM_PHOTO_LIMIT_ERROR_RE = /\b(?:PHOTO_INVALID_DIMENSIONS|PHOTO_TOO_BIG)\b/i;
const TELEGRAM_VOICE_FORBIDDEN_MARKER = "VOICE_MESSAGES_FORBIDDEN";

function resolveTelegramErrorDescription(error: unknown): string {
  return isRecord(error) && typeof error.description === "string"
    ? error.description
    : formatErrorMessage(error);
}

export function isTelegramCaptionTooLongError(error: unknown): boolean {
  return TELEGRAM_CAPTION_TOO_LONG_RE.test(resolveTelegramErrorDescription(error));
}

export function isTelegramPhotoLimitError(error: unknown): boolean {
  return TELEGRAM_PHOTO_LIMIT_ERROR_RE.test(resolveTelegramErrorDescription(error));
}

export function isTelegramVoiceMessagesForbiddenError(error: unknown): boolean {
  return resolveTelegramErrorDescription(error).includes(TELEGRAM_VOICE_FORBIDDEN_MARKER);
}
