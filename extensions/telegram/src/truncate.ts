// Telegram tests cover progress text clipping behavior.
import { compactChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";

/**
 * Default per-line budget for Telegram progress text, counted in UTF-16 code
 * units. Telegram historically clipped at 300; keep that budget when
 * `channels.telegram.streaming.progress.maxLineChars` is unset.
 */
export const TELEGRAM_PROGRESS_MAX_CHARS = 300;

/**
 * Clips Telegram progress text to at most {@link maxLineChars} characters using
 * the shared channel progress compaction: prose cuts at word boundaries, while
 * command/path detail keeps its useful prefix and suffix around a middle
 * ellipsis. Code-point-based cutting never leaves a lone surrogate before the
 * ellipsis, which would serialize to an invalid character in the Telegram Bot
 * API payload.
 */
export function clipTelegramProgressText(
  text: string,
  maxLineChars: number = TELEGRAM_PROGRESS_MAX_CHARS,
): string {
  return compactChannelProgressDraftLine(text, maxLineChars);
}
