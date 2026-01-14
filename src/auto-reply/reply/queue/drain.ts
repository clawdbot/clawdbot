import { defaultRuntime } from "../../../runtime.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun } from "./types.js";

async function waitForQueueDebounce(queue: {
  debounceMs: number;
  lastEnqueuedAt: number;
}) {
  const debounceMs = Math.max(0, queue.debounceMs);
  if (debounceMs <= 0) return;
  while (true) {
    const since = Date.now() - queue.lastEnqueuedAt;
    if (since >= debounceMs) return;
    await new Promise((resolve) => setTimeout(resolve, debounceMs - since));
  }
}

function buildSummaryPrompt(queue: {
  dropPolicy: "summarize" | "old" | "new";
  droppedCount: number;
  summaryLines: string[];
}): string | undefined {
  if (queue.dropPolicy !== "summarize" || queue.droppedCount <= 0) {
    return undefined;
  }
  const lines = [
    `[Queue overflow] Dropped ${queue.droppedCount} message${queue.droppedCount === 1 ? "" : "s"} due to cap.`,
  ];
  if (queue.summaryLines.length > 0) {
    lines.push("Summary:");
    for (const line of queue.summaryLines) {
      lines.push(`- ${line}`);
    }
  }
  queue.droppedCount = 0;
  queue.summaryLines = [];
  return lines.join("\\n");
}

function buildCollectPrompt(items: FollowupRun[], summary?: string): string {
  const blocks: string[] = ["[Queued messages while agent was busy]"];
  if (summary) blocks.push(summary);
  items.forEach((item, idx) => {
    blocks.push(`---\\nQueued #${idx + 1}\\n${item.prompt}`.trim());
  });
  return blocks.join("\\n\\n");
}

/**
 * Checks if queued items have different routable originating channels.
 *
 * Returns true if messages come from different channels (e.g., Slack + Telegram),
 * meaning they cannot be safely collected into one prompt without losing routing.
 * Also returns true for a mix of routable and non-routable channels.
 */
function hasCrossChannelItems(items: FollowupRun[]): boolean {
  const keys = new Set<string>();
  let hasUnkeyed = false;

  for (const item of items) {
    const channel = item.originatingChannel;
    const to = item.originatingTo;
    const accountId = item.originatingAccountId;
    const threadId = item.originatingThreadId;
    if (!channel && !to && !accountId && typeof threadId !== "number") {
      hasUnkeyed = true;
      continue;
    }
    if (!isRoutableChannel(channel) || !to) {
      return true;
    }
    keys.add(
      [
        channel,
        to,
        accountId || "",
        typeof threadId === "number" ? String(threadId) : "",
      ].join("|"),
    );
  }

  if (keys.size === 0) return false;
  if (hasUnkeyed) return true;
  return keys.size > 1;
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = FOLLOWUP_QUEUES.get(key);
  if (!queue || queue.draining) return;
  queue.draining = true;
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
          const isCrossChannel = hasCrossChannelItems(queue.items);

          if (isCrossChannel) {
            forceIndividualCollect = true;
            const next = queue.items.shift();
            if (!next) break;
            await runFollowup(next);
            continue;
          }

          const items = queue.items.splice(0, queue.items.length);
          const summary = buildSummaryPrompt(queue);
          const run = items.at(-1)?.run ?? queue.lastRun;
          if (!run) break;

          // Preserve originating channel from items when collecting same-channel.
          const originatingChannel = items.find(
            (i) => i.originatingChannel,
          )?.originatingChannel;
          const originatingTo = items.find(
            (i) => i.originatingTo,
          )?.originatingTo;
          const originatingAccountId = items.find(
            (i) => i.originatingAccountId,
          )?.originatingAccountId;
          const originatingThreadId = items.find(
            (i) => typeof i.originatingThreadId === "number",
          )?.originatingThreadId;

          const prompt = buildCollectPrompt(items, summary);
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

        const summaryPrompt = buildSummaryPrompt(queue);
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
      defaultRuntime.error?.(
        `followup queue drain failed for ${key}: ${String(err)}`,
      );
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(key);
      } else {
        scheduleFollowupDrain(key, runFollowup);
      }
    }
  })();
}
