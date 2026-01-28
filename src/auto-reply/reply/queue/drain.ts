import { defaultRuntime } from "../../../runtime.js";
import {
  buildCollectPrompt,
  buildQueueSummaryPrompt,
  hasCrossChannelItems,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES, persistFollowupQueues } from "./state.js";
import type { FollowupRun } from "./types.js";

// Grace period before deleting empty queues (to handle subagent announce race conditions)
const EMPTY_QUEUE_GRACE_PERIOD_MS = 30_000;

// Periodic cleanup of expired empty queues
let cleanupTimer: NodeJS.Timeout | null = null;

function scheduleQueueCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, queue] of FOLLOWUP_QUEUES.entries()) {
      if (queue.items.length === 0 && queue.droppedCount === 0 && queue.emptyAt) {
        const emptyDuration = now - queue.emptyAt;
        if (emptyDuration >= EMPTY_QUEUE_GRACE_PERIOD_MS) {
          FOLLOWUP_QUEUES.delete(key);
        }
      }
    }
    persistFollowupQueues();
  }, EMPTY_QUEUE_GRACE_PERIOD_MS);
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = FOLLOWUP_QUEUES.get(key);
  if (!queue || queue.draining) return;
  queue.draining = true;
  scheduleQueueCleanup();
  void (async () => {
    try {
      let forceIndividualCollect = false;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          // Once the batch is mixed, never collect again within this drain.
          // Prevents “collect after shift” collapsing different targets.
          //
          // Debug: `pnpm test src/auto-reply/reply/queue.collect-routing.test.ts`
          if (forceIndividualCollect) {
            const next = queue.items.shift();
            if (!next) break;
            await runFollowup(next);
            continue;
          }

          // Check if messages span multiple channels.
          // If so, process individually to preserve per-message routing.
          const isCrossChannel = hasCrossChannelItems(queue.items, (item) => {
            const channel = item.originatingChannel;
            const to = item.originatingTo;
            const accountId = item.originatingAccountId;
            const threadId = item.originatingThreadId;
            if (!channel && !to && !accountId && typeof threadId !== "number") {
              return {};
            }
            if (!isRoutableChannel(channel) || !to) {
              return { cross: true };
            }
            const threadKey = typeof threadId === "number" ? String(threadId) : "";
            return {
              key: [channel, to, accountId || "", threadKey].join("|"),
            };
          });

          if (isCrossChannel) {
            forceIndividualCollect = true;
            const next = queue.items.shift();
            if (!next) break;
            await runFollowup(next);
            continue;
          }

          const items = queue.items.splice(0, queue.items.length);
          const summary = buildQueueSummaryPrompt({ state: queue, noun: "message" });
          const run = items.at(-1)?.run ?? queue.lastRun;
          if (!run) break;

          // Preserve originating channel from items when collecting same-channel.
          const originatingChannel = items.find((i) => i.originatingChannel)?.originatingChannel;
          const originatingTo = items.find((i) => i.originatingTo)?.originatingTo;
          const originatingAccountId = items.find(
            (i) => i.originatingAccountId,
          )?.originatingAccountId;
          const originatingThreadId = items.find(
            (i) => typeof i.originatingThreadId === "number",
          )?.originatingThreadId;

          const prompt = buildCollectPrompt({
            title: "[Queued messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          await runFollowup({
            prompt,
            run,
            enqueuedAt: Date.now(),
            originatingChannel,
            originatingTo,
            originatingAccountId,
            originatingThreadId,
          });
          continue;
        }

        const summaryPrompt = buildQueueSummaryPrompt({ state: queue, noun: "message" });
        if (summaryPrompt) {
          const run = queue.lastRun;
          if (!run) break;
          await runFollowup({
            prompt: summaryPrompt,
            run,
            enqueuedAt: Date.now(),
          });
          continue;
        }

        const next = queue.items.shift();
        if (!next) break;
        await runFollowup(next);
      }
    } catch (err) {
      defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      const isEmpty = queue.items.length === 0 && queue.droppedCount === 0;

      if (isEmpty) {
        // Mark when queue became empty
        if (!queue.emptyAt) {
          queue.emptyAt = Date.now();
        }

        // Only delete if it's been empty for the grace period
        // This prevents race conditions with subagent announces
        const emptyDuration = Date.now() - queue.emptyAt;
        if (emptyDuration >= EMPTY_QUEUE_GRACE_PERIOD_MS) {
          FOLLOWUP_QUEUES.delete(key);
        }
      } else {
        // Queue has items, clear emptyAt and continue draining
        queue.emptyAt = undefined;
        scheduleFollowupDrain(key, runFollowup);
      }

      persistFollowupQueues();
    }
  })();
}
