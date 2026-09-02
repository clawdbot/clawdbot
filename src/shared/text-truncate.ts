import { truncateUtf16Safe, truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";

export function truncateUtf16WithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return truncateUtf16Safe(value, maxLength);
  }
  return truncateWithMarker(value, maxLength, { marker: "…", reserve: 1, trimEnd: false });
}

export function truncateCodePointsAtWordBoundary(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return "…";
  }
  // Include the first omitted code point so a complete final word is retained.
  // Keep the whitespace position in code points, matching maxChars.
  const boundary = chars.slice(0, maxChars).findLastIndex((char) => /\s/u.test(char));
  const end = boundary > Math.floor(maxChars * 0.6) ? boundary : maxChars - 1;
  return `${chars.slice(0, end).join("").trimEnd()}…`;
}
