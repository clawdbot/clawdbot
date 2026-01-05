/**
 * Telegram message formatting utilities
 * Uses telegramify-markdown for MarkdownV2 conversion
 * Enforces restricted emoji set (black/white only)
 *
 * ALLOWED EMOJI (KISS - valuable only):
 *
 *   STATUS (progress states):
 *     ○  empty/waiting          [circle-outline]
 *     ◐  in progress            [circle-half-left]
 *     ●  done/complete          [circle-filled]
 *     ◑  timeout/partial        [circle-half-right]
 *
 *   NUMBERS (lists, steps):
 *     ① ② ③ ④ ⑤               [circled-number]
 *
 *   ARROWS (direction, minimal):
 *     ➡  next/forward           [arrow-right]
 *     ⬅  back                   [arrow-left]
 *
 *   SYMBOLS:
 *     ✂︎  error/cut             [black-scissors]
 */

import telegramifyMarkdown from "telegramify-markdown";

const ALLOWED_EMOJI = new Set([
  // Status: empty → in-progress → done → timeout
  "○", "◐", "●", "◑",
  // Numbers (for lists)
  "①", "②", "③", "④", "⑤",
  // Arrows (minimal set)
  "➡", "⬅",
  // Symbols (with and without variation selector)
  "✂", "✂︎",
]);

// Comprehensive emoji regex - covers all Unicode emoji ranges
// Note: \uFE0F (variation selector) is handled separately first
const EMOJI_REGEX = /[\u{1F1E0}-\u{1F1FF}\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}-\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}-\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

/**
 * Strip all emojis except allowed black/white set
 * 1. Strip variation selector (makes emojis colorful)
 * 2. Then apply emoji regex filter
 */
function stripColorfulEmoji(text: string): string {
  // First strip variation selector \uFE0F (makes text style → emoji style)
  const noVariation = text.replace(/\uFE0F/g, "");
  // Then filter emojis
  return noVariation.replace(EMOJI_REGEX, (match) =>
    ALLOWED_EMOJI.has(match) ? match : ""
  );
}

/**
 * Format message for Telegram with MarkdownV2
 * 1. Strips colorful emojis
 * 2. Converts to Telegram MarkdownV2 format
 */
export function formatTelegramMessage(text: string): string {
  const noColorEmoji = stripColorfulEmoji(text);
  return telegramifyMarkdown(noColorEmoji, "escape");
}

/**
 * Same as formatTelegramMessage but escapes all Markdown
 * Use for plain text messages
 */
export function formatPlainText(text: string): string {
  const noColorEmoji = stripColorfulEmoji(text);
  // Escape MarkdownV2 special chars
  return noColorEmoji.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
