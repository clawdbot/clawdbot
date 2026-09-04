// Small progress-draft line helpers shared by streaming renderers.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChannelProgressDraftLine } from "./streaming.js";

/** Progress draft state can mix legacy plain text lines with keyed structured lines. */
type ProgressDraftLine = string | ChannelProgressDraftLine;

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

/**
 * Removes a keyed structured progress line while preserving plain text draft lines.
 * Returns the original array when no line is removed so renderers can use identity as a no-op signal.
 */
export function removeChannelProgressDraftLine<TLine extends ProgressDraftLine>(
  lines: TLine[],
  id: string,
): TLine[] {
  const lineId = id.trim();
  if (!lineId) {
    return lines;
  }
  const next = lines.filter((line) => typeof line !== "object" || line.id?.trim() !== lineId);
  // Reference equality is part of the caller contract; redraw/delete work only runs after a real removal.
  return next.length === lines.length ? lines : next;
}
