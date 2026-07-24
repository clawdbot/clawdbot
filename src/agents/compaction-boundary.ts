import { parseStrictTimestampStringMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "./runtime/index.js";

export type CompactionBoundary = {
  latestSummaryIndex: number;
  latestSummaryTimestamp: number | null;
  maxSummaryTimestamp: number | null;
  retainedStartIndex: number | null;
  retainedEndIndex: number | null;
};

export function parseCompactionBoundaryTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return parseStrictTimestampStringMs(value) ?? null;
  }
  return null;
}

function parseRetainedMessageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function resolveCompactionBoundary(messages: AgentMessage[]): CompactionBoundary | null {
  let latestSummaryIndex = -1;
  let latestSummaryTimestamp: number | null = null;
  let maxSummaryTimestamp: number | null = null;
  let retainedMessageCount: number | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if ((message as { role?: unknown } | undefined)?.role !== "compactionSummary") {
      continue;
    }
    const summary = message as AgentMessage & {
      retainedMessageCount?: unknown;
      timestamp?: unknown;
    };
    const timestamp = parseCompactionBoundaryTimestamp(summary.timestamp);
    latestSummaryIndex = index;
    latestSummaryTimestamp = timestamp;
    retainedMessageCount = parseRetainedMessageCount(summary.retainedMessageCount);
    if (timestamp !== null) {
      maxSummaryTimestamp =
        maxSummaryTimestamp === null ? timestamp : Math.max(maxSummaryTimestamp, timestamp);
    }
  }

  if (latestSummaryIndex === -1) {
    return null;
  }
  const retainedStartIndex =
    retainedMessageCount === null ? null : Math.min(messages.length, latestSummaryIndex + 1);
  const retainedEndIndex =
    retainedStartIndex === null || retainedMessageCount === null
      ? null
      : Math.min(messages.length, retainedStartIndex + retainedMessageCount);
  return {
    latestSummaryIndex,
    latestSummaryTimestamp,
    maxSummaryTimestamp,
    retainedStartIndex,
    retainedEndIndex,
  };
}

export function isWithinRetainedCompactionRange(
  boundary: CompactionBoundary,
  messageIndex: number,
): boolean {
  return (
    boundary.retainedStartIndex !== null &&
    boundary.retainedEndIndex !== null &&
    messageIndex >= boundary.retainedStartIndex &&
    messageIndex < boundary.retainedEndIndex
  );
}
