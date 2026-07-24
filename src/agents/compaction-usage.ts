/**
 * Shared helpers for clearing assistant usage snapshots invalidated by
 * transcript compaction.
 */
import {
  isWithinRetainedCompactionRange,
  parseCompactionBoundaryTimestamp,
  resolveCompactionBoundary,
} from "./compaction-boundary.js";
import type { AgentMessage } from "./runtime/index.js";
import { makeZeroUsageSnapshot } from "./usage.js";

export function stripStaleAssistantUsageBeforeLatestCompaction<TMessage extends AgentMessage>(
  messages: TMessage[],
  options: {
    mutate?: boolean;
    whenMissingCompactionSummary?: "preserve" | "zeroAssistantUsage";
  } = {},
): TMessage[] {
  const boundary = resolveCompactionBoundary(messages);
  const hasCompactionSummary = boundary !== null;
  if (!hasCompactionSummary && options.whenMissingCompactionSummary !== "zeroAssistantUsage") {
    return messages;
  }

  const out = options.mutate ? messages : [...messages];
  let touched = false;
  for (let i = 0; i < out.length; i += 1) {
    const candidate = out[i] as
      | (AgentMessage & { usage?: unknown; timestamp?: unknown })
      | undefined;
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    if (!candidate.usage || typeof candidate.usage !== "object") {
      continue;
    }

    const messageTimestamp = parseCompactionBoundaryTimestamp(candidate.timestamp);
    const compactionTimestamp = boundary?.latestSummaryTimestamp ?? null;
    const hasTimestampBoundary =
      hasCompactionSummary && compactionTimestamp !== null && messageTimestamp !== null;
    const staleByMissingSummary = !hasCompactionSummary;
    const staleByTimestamp = hasTimestampBoundary && messageTimestamp <= compactionTimestamp;
    const staleByRetainedRange =
      boundary !== null && !hasTimestampBoundary && isWithinRetainedCompactionRange(boundary, i);
    const staleByLegacyOrdering =
      boundary !== null &&
      !hasTimestampBoundary &&
      boundary.retainedStartIndex === null &&
      i < boundary.latestSummaryIndex;
    if (
      !staleByMissingSummary &&
      !staleByTimestamp &&
      !staleByRetainedRange &&
      !staleByLegacyOrdering
    ) {
      continue;
    }

    // Session runtime expects assistant usage to stay structurally valid during
    // accounting. Keep stale snapshots present, but zeroed after compaction.
    const candidateRecord = candidate as unknown as Record<string, unknown>;
    out[i] = {
      ...candidateRecord,
      usage: makeZeroUsageSnapshot(),
    } as unknown as TMessage;
    touched = true;
  }
  return touched ? out : messages;
}
