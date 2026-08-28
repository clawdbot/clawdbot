const TELEGRAM_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

// Telegram Desktop's preformatted font uses two cells for East Asian wide
// graphemes. Keep this local to Telegram grid fallback behavior rather than
// importing the terminal package's broader ANSI-aware width contract.
const TELEGRAM_WIDE_CODE_POINT_PATTERN =
  /[\u1100-\u115F\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FA1F}]/u;
const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const NON_PRINTING_ONLY_PATTERN =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark})+$/u;
const EMOJI_PRESENTATION_SELECTOR = "\uFE0F";
const KEYCAP_COMBINING_MARK = "\u20E3";

function telegramMonospaceGraphemeWidth(grapheme: string): number {
  if (
    grapheme.includes(KEYCAP_COMBINING_MARK) ||
    EMOJI_PRESENTATION_PATTERN.test(grapheme) ||
    (grapheme.includes(EMOJI_PRESENTATION_SELECTOR) && EXTENDED_PICTOGRAPHIC_PATTERN.test(grapheme))
  ) {
    return 2;
  }
  if (TELEGRAM_WIDE_CODE_POINT_PATTERN.test(grapheme)) {
    return 2;
  }
  return NON_PRINTING_ONLY_PATTERN.test(grapheme) ? 0 : 1;
}

function telegramMonospaceWidth(text: string): number {
  let width = 0;
  for (const { segment } of TELEGRAM_GRAPHEME_SEGMENTER.segment(text)) {
    width += telegramMonospaceGraphemeWidth(segment);
  }
  return width;
}

function padTelegramMonospaceCell(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - telegramMonospaceWidth(text)))}`;
}

export function renderTelegramMonospaceGrid(
  rows: readonly (readonly string[])[],
  options: { headerSeparator?: boolean } = {},
): string {
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const widths = Array.from({ length: columnCount }, () => 3);
  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      widths[index] = Math.max(widths[index] ?? 3, telegramMonospaceWidth(row[index] ?? ""));
    }
  }
  const renderRow = (row: readonly string[]) =>
    `| ${widths.map((width, index) => padTelegramMonospaceCell(row[index] ?? "", width)).join(" | ")} |`;
  const lines = rows.map(renderRow);
  if (options.headerSeparator && lines.length > 0) {
    lines.splice(1, 0, `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
  }
  return lines.join("\n");
}
