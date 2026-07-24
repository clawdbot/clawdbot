import { parseStrictTimestampStringMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "./runtime/index.js";

const COMPACTION_RETAINED_BOUNDARY = Symbol.for("openclaw.compactionRetainedBoundary");

type CompactionBoundaryMarkedMessage = AgentMessage & {
  [COMPACTION_RETAINED_BOUNDARY]?: unknown;
};

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

function getCompactionBoundaryId(message: AgentMessage): string | null {
  const value = (message as CompactionBoundaryMarkedMessage)[COMPACTION_RETAINED_BOUNDARY];
  return typeof value === "string" ? value : null;
}

function withCompactionBoundaryId(message: AgentMessage, boundaryId: string): AgentMessage {
  const marked = { ...message } as CompactionBoundaryMarkedMessage;
  Object.defineProperty(marked, COMPACTION_RETAINED_BOUNDARY, {
    configurable: true,
    enumerable: true,
    value: boundaryId,
  });
  return marked;
}

function compactionMessageKey(message: AgentMessage): string {
  const record = message as AgentMessage & {
    content?: unknown;
    customType?: unknown;
    fromId?: unknown;
    model?: unknown;
    provider?: unknown;
    role?: unknown;
    summary?: unknown;
    timestamp?: unknown;
    tokensBefore?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
  };
  try {
    return JSON.stringify({
      content: record.content,
      customType: record.customType,
      fromId: record.fromId,
      model: record.model,
      provider: record.provider,
      role: record.role,
      summary: record.summary,
      timestamp: record.timestamp,
      tokensBefore: record.tokensBefore,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
    });
  } catch {
    return `${record.role ?? "unknown"}:${String(record.timestamp ?? "")}`;
  }
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
    const summary = message as CompactionBoundaryMarkedMessage & {
      retainedMessageCount?: unknown;
      timestamp?: unknown;
    };
    const timestamp = parseCompactionBoundaryTimestamp(summary.timestamp);
    latestSummaryIndex = index;
    latestSummaryTimestamp = timestamp;
    retainedMessageCount = parseRetainedMessageCount(summary.retainedMessageCount);
    retainedBoundaryId = getCompactionBoundaryId(summary);
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
            return getCompactionBoundaryId(message) === retainedBoundaryId ? [index] : [];
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

/**
 * Rebind the host-owned retained range after a context engine returns a transformed message
 * array. Engines may clone messages with structuredClone(), which intentionally drops symbols.
 */
export function rebindCompactionBoundaryMessages(
  sourceMessages: AgentMessage[],
  transformedMessages: AgentMessage[],
): AgentMessage[] {
  const sourceBoundary = resolveCompactionBoundary(sourceMessages);
  if (!sourceBoundary?.retainedMessageIndexes) {
    return transformedMessages;
  }
  const sourceSummary = sourceMessages[sourceBoundary.latestSummaryIndex];
  const boundaryId = sourceSummary ? getCompactionBoundaryId(sourceSummary) : null;
  if (!boundaryId) {
    return transformedMessages;
  }

  let transformedSummaryIndex = -1;
  for (let index = transformedMessages.length - 1; index >= 0; index -= 1) {
    if (transformedMessages[index]?.role === "compactionSummary") {
      transformedSummaryIndex = index;
      break;
    }
  }
  if (transformedSummaryIndex === -1) {
    return transformedMessages;
  }

  const sourceIndexesByKey = new Map<string, number[]>();
  for (let index = 0; index < sourceMessages.length; index += 1) {
    if (index === sourceBoundary.latestSummaryIndex) {
      continue;
    }
    const key = compactionMessageKey(sourceMessages[index] as AgentMessage);
    const indexes = sourceIndexesByKey.get(key) ?? [];
    indexes.push(index);
    sourceIndexesByKey.set(key, indexes);
  }

  let matchedRetainedCount = 0;
  let changed = false;
  const rebound = transformedMessages.map((message, index) => {
    if (index === transformedSummaryIndex) {
      const summary = message as AgentMessage & { retainedMessageCount?: unknown };
      if (
        getCompactionBoundaryId(message) === boundaryId &&
        summary.retainedMessageCount === sourceBoundary.retainedMessageIndexes?.size
      ) {
        return message;
      }
      const marked = {
        ...message,
        retainedMessageCount: 0,
      } as AgentMessage & { retainedMessageCount?: number };
      Object.defineProperty(marked, COMPACTION_RETAINED_BOUNDARY, {
        configurable: true,
        enumerable: true,
        value: boundaryId,
      });
      changed = true;
      return marked;
    }

    const candidates = sourceIndexesByKey.get(compactionMessageKey(message));
    const sourceIndex = candidates?.shift();
    if (sourceIndex === undefined || !sourceBoundary.retainedMessageIndexes?.has(sourceIndex)) {
      return message;
    }
    matchedRetainedCount += 1;
    if (getCompactionBoundaryId(message) === boundaryId) {
      return message;
    }
    changed = true;
    return withCompactionBoundaryId(message, boundaryId);
  });

  if (!changed) {
    return transformedMessages;
  }
  const summary = rebound[transformedSummaryIndex] as AgentMessage & {
    retainedMessageCount?: number;
  };
  if (summary.retainedMessageCount !== matchedRetainedCount) {
    const updated = { ...summary, retainedMessageCount: matchedRetainedCount };
    Object.defineProperty(updated, COMPACTION_RETAINED_BOUNDARY, {
      configurable: true,
      enumerable: true,
      value: boundaryId,
    });
    rebound[transformedSummaryIndex] = updated as AgentMessage;
  }
  return rebound;
}
