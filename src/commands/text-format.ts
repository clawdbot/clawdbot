// Tiny text formatting helpers shared by command output.
// Uses Array.from so truncation respects Unicode code points instead of UTF-16 units.

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
