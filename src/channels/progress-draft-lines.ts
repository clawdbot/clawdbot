// Small progress-draft line helpers shared by streaming renderers.
import type { ChannelProgressDraftLine } from "./streaming.js";

/** Progress draft state can mix legacy plain text lines with keyed structured lines. */
export type ProgressDraftLine = string | ChannelProgressDraftLine;

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
