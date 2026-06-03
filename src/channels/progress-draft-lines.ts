import type { ChannelProgressDraftLine } from "./streaming.js";

export type ProgressDraftLine = string | ChannelProgressDraftLine;

export function removeChannelProgressDraftLine<TLine extends ProgressDraftLine>(
  lines: TLine[],
  id: string,
): TLine[] {
  const lineId = id.trim();
  if (!lineId) {
    return lines;
  }
  const next = lines.filter((line) => typeof line !== "object" || line.id?.trim() !== lineId);
  return next.length === lines.length ? lines : next;
}
