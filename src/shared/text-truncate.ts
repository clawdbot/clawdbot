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
