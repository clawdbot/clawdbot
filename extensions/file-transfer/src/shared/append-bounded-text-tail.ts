// Bounded stderr tails must stay UTF-16 safe when tar/dir-fetch paths mention emoji filenames.
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

// Final error projections reuse the ring-buffer tail; raw slice(-N) can still bisect emoji.
export function projectBoundedTextTail(text: string, maxChars: number): string {
  return sliceUtf16Safe(text, Math.max(0, text.length - maxChars));
}
