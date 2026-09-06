// Text formatting helpers shared by command output.
import * as terminalAnsi from "../../packages/terminal-core/src/ansi.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Shortens text to maxLen code points, appending an ellipsis when truncated. */
export const shortenText = (value: string, maxLen: number) => {
  if (maxLen <= 0) {
    return "";
  }
  if (value.length <= maxLen) {
    return value;
  }
  // Include an overflow code point; each point occupies at most two UTF-16 units.
  const chars = Array.from(value.slice(0, (maxLen + 1) * 2));
  return chars.length <= maxLen ? value : `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};

/** Fits a plain-text terminal cell using visible width and whole graphemes. */
export function formatTextCell(text: string, width: number): string {
  // Eight UTF-16 units per column allow ordinary accents/emoji; reserve width for padding.
  // Whole-cluster raw bounds also catch invisible runs and oversized single graphemes.
  const overflow = graphemeSegmenter.segment(text).containing(width * 7);
  const bounded = overflow ? `${text.slice(0, overflow.index)}…` : text;
  const boundedWidth = terminalAnsi.visibleWidth(bounded);
  const fitted =
    boundedWidth > width ? `${terminalAnsi.truncateToVisibleWidth(bounded, width - 1)}…` : bounded;
  const fittedWidth = fitted === bounded ? boundedWidth : terminalAnsi.visibleWidth(fitted);
  return `${fitted}${" ".repeat(width - fittedWidth)}`;
}
