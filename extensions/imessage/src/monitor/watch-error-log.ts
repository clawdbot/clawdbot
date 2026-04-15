import {
  isRecord,
  sanitizeTerminalText,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/text-runtime";

const MAX_WATCH_ERROR_MESSAGE_CHARS = 200;

export type SanitizedIMessageWatchErrorPayload = {
  code?: number;
  message?: string;
};

export function sanitizeIMessageWatchErrorPayload(
  payload: unknown,
): SanitizedIMessageWatchErrorPayload {
  if (!isRecord(payload)) {
    return {};
  }

  const safe: SanitizedIMessageWatchErrorPayload = {};

  if (typeof payload.code === "number" && Number.isFinite(payload.code)) {
    safe.code = payload.code;
  }

  if (typeof payload.message === "string") {
    const sanitizedMessage = sanitizeTerminalText(payload.message);
    if (sanitizedMessage) {
      safe.message =
        sanitizedMessage.length > MAX_WATCH_ERROR_MESSAGE_CHARS
          ? `${truncateUtf16Safe(sanitizedMessage, MAX_WATCH_ERROR_MESSAGE_CHARS - 1)}…`
          : sanitizedMessage;
    }
  }

  return safe;
}
