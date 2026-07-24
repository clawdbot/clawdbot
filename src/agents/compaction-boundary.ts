import { parseStrictTimestampStringMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "./runtime/index.js";

const COMPACTION_RETAINED_BOUNDARY = Symbol.for("openclaw.compactionRetainedBoundary");

export type CompactionBoundary = {
  latestSummaryIndex: number;
  latestSummaryTimestamp: number | null;
  maxSummaryTimestamp: number | null;
  retainedStartIndex: number | null;
  retainedEndIndex: number | null;
  retainedMessageIndexes: ReadonlySet<number> | null;
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
  let retainedBoundaryId: string | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if ((message as { role?: unknown } | undefined)?.role !== "compactionSummary") {
      continue;
    }
    const summary = message as AgentMessage & {
      [COMPACTION_RETAINED_BOUNDARY]?: unknown;
      retainedMessageCount?: unknown;
      timestamp?: unknown;
    };
    const timestamp = parseCompactionBoundaryTimestamp(summary.timestamp);
    latestSummaryIndex = index;
    latestSummaryTimestamp = timestamp;
    retainedMessageCount = parseRetainedMessageCount(summary.retainedMessageCount);
    retainedBoundaryId =
      typeof summary[COMPACTION_RETAINED_BOUNDARY] === "string"
        ? summary[COMPACTION_RETAINED_BOUNDARY]
        : null;
    if (timestamp !== null) {
      maxSummaryTimestamp =
        maxSummaryTimestamp === null ? timestamp : Math.max(maxSummaryTimestamp, timestamp);
    }
  }

  if (latestSummaryIndex === -1) {
    return null;
  }
  const retainedMessageIndexes =
    retainedBoundaryId === null
      ? null
      : new Set(
          messages.flatMap((message, index) => {
            if (index <= latestSummaryIndex) {
              return [];
            }
            const marked = message as AgentMessage & {
              [COMPACTION_RETAINED_BOUNDARY]?: unknown;
            };
            return marked[COMPACTION_RETAINED_BOUNDARY] === retainedBoundaryId ? [index] : [];
          }),
        );
  const explicitRetainedIndexes = retainedMessageIndexes
    ? Array.from(retainedMessageIndexes)
    : null;
  const retainedStartIndex = explicitRetainedIndexes
    ? (explicitRetainedIndexes.at(0) ?? Math.min(messages.length, latestSummaryIndex + 1))
    : retainedMessageCount === null
      ? null
      : Math.min(messages.length, latestSummaryIndex + 1);
  const retainedEndIndex = explicitRetainedIndexes
    ? (explicitRetainedIndexes.at(-1) ?? retainedStartIndex) +
      (explicitRetainedIndexes.length > 0 ? 1 : 0)
    : retainedStartIndex === null || retainedMessageCount === null
      ? null
      : Math.min(messages.length, retainedStartIndex + retainedMessageCount);
  return {
    latestSummaryIndex,
    latestSummaryTimestamp,
    maxSummaryTimestamp,
    retainedStartIndex,
    retainedEndIndex,
    retainedMessageIndexes,
  };
}

export function isWithinRetainedCompactionRange(
  boundary: CompactionBoundary,
  messageIndex: number,
): boolean {
  if (boundary.retainedMessageIndexes !== null) {
    return boundary.retainedMessageIndexes.has(messageIndex);
  }
  return (
    boundary.retainedStartIndex !== null &&
    boundary.retainedEndIndex !== null &&
    messageIndex >= boundary.retainedStartIndex &&
    messageIndex < boundary.retainedEndIndex
  );
}
