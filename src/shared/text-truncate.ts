import {
  sliceUtf16Safe,
  truncateUtf16Safe,
  truncateWithMarker,
} from "@openclaw/normalization-core/utf16-slice";

export function truncateUtf16WithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return truncateUtf16Safe(value, maxLength);
  }
  return truncateWithMarker(value, maxLength, { marker: "…", reserve: 1, trimEnd: false });
}

/** Compacts normalized text; callers can reuse their bounded character prefix. */
export function compactProgressText(
  text: string,
  maxChars: number,
  chars = Array.from(sliceUtf16Safe(text, 0, (Math.max(0, maxChars) + 1) * 2)),
): string {
  if (chars.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return "…";
  }
  const head = chars
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd();
  const boundary = head.search(/\s+\S*$/u);
  if (boundary > Math.floor(maxChars * 0.6)) {
    return `${head.slice(0, boundary).trimEnd()}…`;
  }
  return `${head}…`;
}
