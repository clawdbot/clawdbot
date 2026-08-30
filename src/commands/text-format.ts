// Tiny text formatting helpers shared by command output.
import { truncateToVisibleWidth, visibleWidth } from "../../packages/terminal-core/src/ansi.js";

/** Shortens text to maxLen code points, appending an ellipsis when truncated. */
export const shortenText = (value: string, maxLen: number) => {
  if (maxLen <= 0) {
    return "";
  }
  const chars = Array.from(value);
  if (chars.length <= maxLen) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};

/** Fits a plain-text terminal cell using visible width and whole graphemes. */
export function formatTextCell(text: string, width: number): string {
  const fitted = visibleWidth(text) > width ? `${truncateToVisibleWidth(text, width - 1)}…` : text;
  return `${fitted}${" ".repeat(width - visibleWidth(fitted))}`;
}
