import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";
import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";

function elideText(text: string, limit = 140): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function buildQueueSummaryLine(run: FollowupRun): string {
  const base = run.summaryLine?.trim() || run.prompt.trim();
  const cleaned = base.replace(/\\s+/g, " ").trim();
  return elideText(cleaned, 160);
}

function isRunAlreadyQueued(
  run: FollowupRun,
  items: FollowupRun[],
  allowPromptFallback = false,
): boolean {
  const hasSameRouting = (item: FollowupRun) =>
    item.originatingChannel === run.originatingChannel &&
    item.originatingTo === run.originatingTo &&
    item.originatingAccountId === run.originatingAccountId &&
    item.originatingThreadId === run.originatingThreadId;

  const messageId = run.messageId?.trim();
  if (messageId) {
    return items.some(
      (item) => item.messageId?.trim() === messageId && hasSameRouting(item),
    );
  }
  if (!allowPromptFallback) return false;
  return items.some(
    (item) => item.prompt === run.prompt && hasSameRouting(item),
  );
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): boolean {
  const queue = getFollowupQueue(key, settings);

  // Deduplicate: skip if the same message is already queued.
  if (dedupeMode !== "none") {
    if (dedupeMode === "message-id" && isRunAlreadyQueued(run, queue.items)) {
      return false;
    }
    if (dedupeMode === "prompt" && isRunAlreadyQueued(run, queue.items, true)) {
      return false;
    }
  }

  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;

  const cap = queue.cap;
  if (cap > 0 && queue.items.length >= cap) {
    if (queue.dropPolicy === "new") {
      return false;
    }
    const dropCount = queue.items.length - cap + 1;
    const dropped = queue.items.splice(0, dropCount);
    if (queue.dropPolicy === "summarize") {
      for (const item of dropped) {
        queue.droppedCount += 1;
        queue.summaryLines.push(buildQueueSummaryLine(item));
      }
      while (queue.summaryLines.length > cap) queue.summaryLines.shift();
    }
  }

  queue.items.push(run);
  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const cleaned = key.trim();
  if (!cleaned) return 0;
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) return 0;
  return queue.items.length;
}
