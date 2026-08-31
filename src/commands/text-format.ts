// Text formatting helpers shared by command output.
import * as terminalAnsi from "../../packages/terminal-core/src/ansi.js";

/** Shortens text to maxLen code points, appending an ellipsis when truncated. */
export const shortenText = (value: string, maxLen: number) => {
  if (maxLen <= 0) {
    return "";
  }
  const chars = Array.from(value);
  return chars.length <= maxLen ? value : `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};

/** Fits a plain-text terminal cell using visible width and whole graphemes. */
export function formatTextCell(text: string, width: number): string {
  // Eight UTF-16 units per column allow ordinary accents/emoji; reserve width for padding.
  // Whole-cluster raw bounds also catch invisible runs and oversized single graphemes.
  const graphemes = terminalAnsi.splitGraphemes(text);
  let length = 0;
  const end = graphemes.findIndex((grapheme) => (length += grapheme.length) > width * 7);
  const bounded = end < 0 ? text : `${graphemes.slice(0, end).join("")}…`;
  const fitted =
    terminalAnsi.visibleWidth(bounded) > width
      ? `${terminalAnsi.truncateToVisibleWidth(bounded, width - 1)}…`
      : bounded;
  return `${fitted}${" ".repeat(width - terminalAnsi.visibleWidth(fitted))}`;
}
