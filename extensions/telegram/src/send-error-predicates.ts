import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const TELEGRAM_PHOTO_LIMIT_ERROR_RE = /\b(?:PHOTO_INVALID_DIMENSIONS|PHOTO_TOO_BIG)\b/i;

export function isTelegramPhotoLimitError(error: unknown): boolean {
  const description =
    error && typeof error === "object" && "description" in error
      ? (error as { description?: unknown }).description
      : undefined;
  return TELEGRAM_PHOTO_LIMIT_ERROR_RE.test(
    typeof description === "string" ? description : formatErrorMessage(error),
  );
}
