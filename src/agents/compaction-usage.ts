/**
 * Shared helpers for clearing assistant usage snapshots invalidated by
 * transcript compaction.
 */
import type { AgentMessage } from "./runtime/index.js";
import { makeZeroUsageSnapshot } from "./usage.js";

function parseCompactionUsageTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function stripStaleAssistantUsageBeforeLatestCompaction<TMessage extends AgentMessage>(
  messages: TMessage[],
  options: {
    mutate?: boolean;
    whenMissingCompactionSummary?: "preserve" | "zeroAssistantUsage";
  } = {},
): TMessage[] {
  let latestCompactionSummaryIndex = -1;
  let latestCompactionTimestamp: number | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const entry = messages[i];
    if (entry?.role !== "compactionSummary") {
      continue;
    }
    latestCompactionSummaryIndex = i;
    latestCompactionTimestamp = parseCompactionUsageTimestamp(
      (entry as { timestamp?: unknown }).timestamp ?? null,
    );
  }
  const hasCompactionSummary = latestCompactionSummaryIndex !== -1;
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

    const messageTimestamp = parseCompactionUsageTimestamp(candidate.timestamp);
    const compactionTimestamp = latestCompactionTimestamp;
    const hasTimestampBoundary =
      hasCompactionSummary && compactionTimestamp !== null && messageTimestamp !== null;
    const staleByMissingSummary = !hasCompactionSummary;
    const staleByTimestamp = hasTimestampBoundary && messageTimestamp <= compactionTimestamp;
    const staleByLegacyOrdering =
      hasCompactionSummary && !hasTimestampBoundary && i < latestCompactionSummaryIndex;
    if (!staleByMissingSummary && !staleByTimestamp && !staleByLegacyOrdering) {
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
