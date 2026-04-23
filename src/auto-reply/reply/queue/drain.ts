import { defaultRuntime } from "../../../runtime.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import {
  buildCollectPrompt,
  beginQueueDrain,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun } from "./types.js";

// Persists the most recent runFollowup callback per queue key so that
// enqueueFollowupRun can restart a drain that finished and deleted the queue.
const FOLLOWUP_DRAIN_CALLBACKS_KEY = Symbol.for("openclaw.followupDrainCallbacks");

const FOLLOWUP_RUN_CALLBACKS = resolveGlobalMap<string, (run: FollowupRun) => Promise<void>>(
  FOLLOWUP_DRAIN_CALLBACKS_KEY,
);

export function rememberFollowupDrainCallback(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  FOLLOWUP_RUN_CALLBACKS.set(key, runFollowup);
}

export function clearFollowupDrainCallback(key: string): void {
  FOLLOWUP_RUN_CALLBACKS.delete(key);
}

/** Restart the drain for `key` if it is currently idle, using the stored callback. */
export function kickFollowupDrainIfIdle(key: string): void {
  const cb = FOLLOWUP_RUN_CALLBACKS.get(key);
  if (!cb) {
    return;
  }
  scheduleFollowupDrain(key, cb);
}

type OriginRoutingMetadata = Pick<
  FollowupRun,
  "originatingChannel" | "originatingTo" | "originatingAccountId" | "originatingThreadId"
>;

function resolveOriginRoutingMetadata(items: FollowupRun[]): OriginRoutingMetadata {
  return {
    originatingChannel: items.find((item) => item.originatingChannel)?.originatingChannel,
    originatingTo: items.find((item) => item.originatingTo)?.originatingTo,
    originatingAccountId: items.find((item) => item.originatingAccountId)?.originatingAccountId,
    // Support both number (Telegram topic) and string (Slack thread_ts) thread IDs.
    originatingThreadId: items.find(
      (item) => item.originatingThreadId != null && item.originatingThreadId !== "",
    )?.originatingThreadId,
  };
}

// Keep this key aligned with the fields that affect per-message authorization or
// exec-context propagation in collect-mode batching. Display-only sender fields
// stay out of the key so profile/name drift does not force conservative splits.
// Fields like authProfileId, elevatedLevel, ownerNumbers, and config are
// intentionally excluded because they are session-level or not consulted in
// per-message authorization checks.
export function resolveFollowupAuthorizationKey(run: FollowupRun["run"]): string {
  return JSON.stringify([
    run.senderId ?? "",
    run.senderE164 ?? "",
    run.senderIsOwner === true,
    run.execOverrides?.host ?? "",
    run.execOverrides?.security ?? "",
    run.execOverrides?.ask ?? "",
    run.execOverrides?.node ?? "",
    run.bashElevated?.enabled === true,
    run.bashElevated?.allowed === true,
    run.bashElevated?.defaultLevel ?? "",
  ]);
}

function splitCollectItemsByAuthorization(items: FollowupRun[]): FollowupRun[][] {
  if (items.length <= 1) {
    return items.length === 0 ? [] : [items];
  }

  const groups: FollowupRun[][] = [];
  let currentGroup: FollowupRun[] = [];
  let currentKey: string | undefined;

  for (const item of items) {
    const itemKey = resolveFollowupAuthorizationKey(item.run);
    if (currentGroup.length === 0 || itemKey === currentKey) {
      currentGroup.push(item);
      currentKey = itemKey;
      continue;
    }

    groups.push(currentGroup);
    currentGroup = [item];
    currentKey = itemKey;
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function renderCollectItem(item: FollowupRun, idx: number): string {
  const senderLabel =
    item.run.senderName ?? item.run.senderUsername ?? item.run.senderId ?? item.run.senderE164;
  const senderSuffix = senderLabel ? ` (from ${senderLabel})` : "";
  return `---\nQueued #${idx + 1}${senderSuffix}\n${item.prompt}`.trim();
}

function collectQueuedImages(items: FollowupRun[]): Pick<FollowupRun, "images" | "imageOrder"> {
  const images = items.flatMap((item) => item.images ?? []);
  const imageOrder = items.flatMap((item) => item.imageOrder ?? []);
  return {
    ...(images.length > 0 ? { images } : {}),
    ...(imageOrder.length > 0 ? { imageOrder } : {}),
  };
}

function resolveCrossChannelKey(item: FollowupRun): { cross?: true; key?: string } {
  const { originatingChannel: channel, originatingTo: to, originatingAccountId: accountId } = item;
  const threadId = item.originatingThreadId;
  if (!channel && !to && !accountId && (threadId == null || threadId === "")) {
    return {};
  }
  if (!isRoutableChannel(channel) || !to) {
    return { cross: true };
  }
  // Support both number (Telegram topic IDs) and string (Slack thread_ts) thread IDs.
  const threadKey = threadId != null && threadId !== "" ? String(threadId) : "";
  return {
    key: [channel, to, accountId || "", threadKey].join("|"),
  };
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = beginQueueDrain(FOLLOWUP_QUEUES, key);
  if (!queue) {
    return;
  }
  const effectiveRunFollowup = FOLLOWUP_RUN_CALLBACKS.get(key) ?? runFollowup;
  // Cache callback only when a drain actually starts. Avoid keeping stale
  // callbacks around from finalize calls where no queue work is pending.
  rememberFollowupDrainCallback(key, effectiveRunFollowup);
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: false };
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          // Once the batch is mixed, never collect again within this drain.
          // Prevents “collect after shift” collapsing different targets.
          //
          // Debug: `pnpm test src/auto-reply/reply/reply-flow.test.ts`
          // Check if messages span multiple channels.
          // If so, process individually to preserve per-message routing.
          const isCrossChannel = hasCrossChannelItems(queue.items, resolveCrossChannelKey);

          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel,
            items: queue.items,
            run: effectiveRunFollowup,
          });
          if (collectDrainResult === "empty") {
            const summaryOnlyPrompt = previewQueueSummaryPrompt({ state: queue, noun: "message" });
            const run = queue.lastRun;
            if (summaryOnlyPrompt && run) {
              await effectiveRunFollowup({
                prompt: summaryOnlyPrompt,
                run,
                enqueuedAt: Date.now(),
                ...collectQueuedImages(queue.items),
              });
              clearQueueSummaryState(queue);
              continue;
            }
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }

          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt({ state: queue, noun: "message" });
          const authGroups = splitCollectItemsByAuthorization(items);
          if (authGroups.length === 0) {
            const run = queue.lastRun;
            if (!summary || !run) {
              break;
            }
            await effectiveRunFollowup({
              prompt: summary,
              run,
              enqueuedAt: Date.now(),
            });
            clearQueueSummaryState(queue);
            continue;
          }

          let pendingSummary = summary;
          for (const groupItems of authGroups) {
            const run = groupItems.at(-1)?.run ?? queue.lastRun;
            if (!run) {
              break;
            }

            const routing = resolveOriginRoutingMetadata(groupItems);
            const prompt = buildCollectPrompt({
              title: "[Queued messages while agent was busy]",
              items: groupItems,
              summary: pendingSummary,
              renderItem: renderCollectItem,
            });
            await effectiveRunFollowup({
              prompt,
              run,
              enqueuedAt: Date.now(),
              ...routing,
              ...collectQueuedImages(groupItems),
            });
            queue.items.splice(0, groupItems.length);
            if (pendingSummary) {
              clearQueueSummaryState(queue);
              pendingSummary = undefined;
            }
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt({ state: queue, noun: "message" });
        if (summaryPrompt) {
          const run = queue.lastRun;
          if (!run) {
            break;
          }
          if (
            !(await drainNextQueueItem(queue.items, async (item) => {
              await effectiveRunFollowup({
                prompt: summaryPrompt,
                run,
                enqueuedAt: Date.now(),
                originatingChannel: item.originatingChannel,
                originatingTo: item.originatingTo,
                originatingAccountId: item.originatingAccountId,
                originatingThreadId: item.originatingThreadId,
                ...collectQueuedImages([item]),
              });
            }))
          ) {
            break;
          }
          clearQueueSummaryState(queue);
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, effectiveRunFollowup))) {
          break;
        }
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
      defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(key);
        clearFollowupDrainCallback(key);
      } else {
        scheduleFollowupDrain(key, effectiveRunFollowup);
      }
    }
  })();
}
