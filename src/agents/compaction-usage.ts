/**
 * Shared helpers for clearing assistant usage snapshots invalidated by
 * transcript compaction.
 */
import { parseDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "./runtime/index.js";
import { makeZeroUsageSnapshot } from "./usage.js";

export function stripStaleAssistantUsageBeforeLatestCompaction<TMessage extends AgentMessage>(
  messages: TMessage[],
  options: {
    mutate?: boolean;
    whenMissingCompactionSummary?: "preserve" | "zeroAssistantUsage";
  } = {},
): TMessage[] {
  const latestCompactionSummaryIndex = messages.findLastIndex(
    (entry) => entry?.role === "compactionSummary",
  );
  const hasCompactionSummary = latestCompactionSummaryIndex !== -1;
  if (!hasCompactionSummary && options.whenMissingCompactionSummary !== "zeroAssistantUsage") {
    return messages;
  }

  const latestCompactionTimestamp =
    parseDateTimestampMs(
      (messages[latestCompactionSummaryIndex] as { timestamp?: unknown } | undefined)?.timestamp,
    ) ?? null;
  let out = messages;
  for (let i = 0; i < messages.length; i += 1) {
    const candidate = messages[i] as
      | (AgentMessage & { usage?: unknown; timestamp?: unknown })
      | undefined;
    if (
      candidate?.role !== "assistant" ||
      !candidate.usage ||
      typeof candidate.usage !== "object"
    ) {
      continue;
    }

    const messageTimestamp = parseDateTimestampMs(candidate.timestamp) ?? null;
    const stale =
      !hasCompactionSummary ||
      (latestCompactionTimestamp !== null && messageTimestamp !== null
        ? messageTimestamp <= latestCompactionTimestamp
        : i < latestCompactionSummaryIndex);
    if (!stale) {
      continue;
    }

    // Session runtime expects assistant usage to stay structurally valid during
    // accounting. Keep stale snapshots present, but zeroed after compaction.
    if (out === messages && !options.mutate) {
      out = [...messages];
    }
    out[i] = { ...candidate, usage: makeZeroUsageSnapshot() } as TMessage;
  }
  return out;
}
