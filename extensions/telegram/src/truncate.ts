// Telegram tests cover progress text clipping behavior.
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const TELEGRAM_PROGRESS_MAX_CHARS = 300;

/**
 * Clips Telegram progress text to at most {@link TELEGRAM_PROGRESS_MAX_CHARS} UTF-16 code units,
 * slicing on a code-point boundary so a surrogate pair straddling the limit is
 * dropped whole rather than leaving a lone high surrogate in the payload.
 */
export function clipTelegramProgressText(text: string): string {
  if (text.length <= TELEGRAM_PROGRESS_MAX_CHARS) {
    return text;
  }
  // Slice on a code-point boundary so an emoji (or any astral character) that
  // straddles the limit is dropped whole instead of leaving a lone \uD83D-style
  // high surrogate before the ellipsis, which serializes to an invalid character
  // in the Telegram Bot API payload.
  return `${sliceUtf16Safe(text, 0, TELEGRAM_PROGRESS_MAX_CHARS - 1).trimEnd()}…`;
}
