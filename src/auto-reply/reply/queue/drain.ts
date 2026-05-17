import { channelRouteCompactKey } from "../../../plugin-sdk/channel-route.js";
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
import { completeFollowupRunLifecycle, isFollowupRunAborted, type FollowupRun } from "./types.js";

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
  const metadata: OriginRoutingMetadata = {};
  for (const item of items) {
    if (!metadata.originatingChannel && item.originatingChannel) {
      metadata.originatingChannel = item.originatingChannel;
    }
    if (!metadata.originatingTo && item.originatingTo) {
      metadata.originatingTo = item.originatingTo;
    }
    if (!metadata.originatingAccountId && item.originatingAccountId) {
      metadata.originatingAccountId = item.originatingAccountId;
    }
    // Support both number (Telegram topic) and string (Slack thread_ts) thread IDs.
    if (
      metadata.originatingThreadId == null &&
      item.originatingThreadId != null &&
      item.originatingThreadId !== ""
    ) {
      metadata.originatingThreadId = item.originatingThreadId;
    }
    if (
      metadata.originatingChannel &&
      metadata.originatingTo &&
      metadata.originatingAccountId &&
      metadata.originatingThreadId != null
    ) {
      break;
    }
  }
  return metadata;
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
  const images: NonNullable<FollowupRun["images"]> = [];
  const imageOrder: NonNullable<FollowupRun["imageOrder"]> = [];
  for (const item of items) {
    if (item.images) {
      images.push(...item.images);
    }
    if (item.imageOrder) {
      imageOrder.push(...item.imageOrder);
    }
  }
  return {
    ...(images.length > 0 ? { images } : {}),
    ...(imageOrder.length > 0 ? { imageOrder } : {}),
  };
}

type FollowupRuntimeMetadata = Pick<
  FollowupRun,
  | "currentInboundEventKind"
  | "currentInboundContext"
  | "abortSignal"
  | "deliveryCorrelations"
  | "queuedLifecycle"
>;

function hasCurrentTurnRuntimeMetadata(item: FollowupRun): boolean {
  return item.currentInboundEventKind === "room_event" || Boolean(item.currentInboundContext);
}

function hasRuntimeOnlyFollowupMetadata(item: FollowupRun): boolean {
  return Boolean(
    hasCurrentTurnRuntimeMetadata(item) ||
    item.abortSignal ||
    item.deliveryCorrelations?.length ||
    item.queuedLifecycle,
  );
}

function combineAbortSignals(items: readonly FollowupRun[]): AbortSignal | undefined {
  const signals = items.flatMap((item) => (item.abortSignal ? [item.abortSignal] : []));
  if (signals.length === 0) {
    return undefined;
  }
  if (signals.length === 1) {
    return signals[0];
  }
  const nativeAny = (
    AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (nativeAny) {
    return nativeAny(signals);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function collectRuntimeMetadata(
  items: FollowupRun[],
  singletonOwner?: FollowupRun,
): FollowupRuntimeMetadata {
  const candidates = singletonOwner ? [singletonOwner, ...items] : items;
  const currentTurnSource =
    singletonOwner && hasCurrentTurnRuntimeMetadata(singletonOwner)
      ? singletonOwner
      : items.find(hasCurrentTurnRuntimeMetadata);
  const abortSignal = singletonOwner?.abortSignal ?? combineAbortSignals(candidates);
  const deliveryCorrelations = items.flatMap((item) => item.deliveryCorrelations ?? []);
  const lifecycleSource = singletonOwner ?? items.find((item) => item.queuedLifecycle);
  return {
    currentInboundEventKind: currentTurnSource?.currentInboundEventKind,
    currentInboundContext: currentTurnSource?.currentInboundContext,
    abortSignal,
    deliveryCorrelations: deliveryCorrelations.length > 0 ? deliveryCorrelations : undefined,
    queuedLifecycle:
      singletonOwner?.queuedLifecycle ??
      (items.length === 1 ? lifecycleSource?.queuedLifecycle : undefined),
  };
}

function collectSummaryRuntimeMetadata(items: FollowupRun[]): FollowupRuntimeMetadata {
  return collectRuntimeMetadata(items, items.length === 1 ? items[0] : undefined);
}

function clearFollowupQueueSummaryState(queue: {
  dropPolicy: "summarize" | "old" | "new";
  droppedCount: number;
  summaryLines: string[];
  summarySources?: FollowupRun[];
}): void {
  completeFollowupQueueSummarySources(queue);
  clearQueueSummaryState(queue);
}

function completeFollowupQueueSummarySources(queue: { summarySources?: FollowupRun[] }): void {
  for (const item of queue.summarySources ?? []) {
    completeFollowupRunLifecycle(item);
  }
  if (queue.summarySources) {
    queue.summarySources = [];
  }
}

async function runWithSummarySourceCleanup(
  queue: { summarySources?: FollowupRun[] },
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } finally {
    completeFollowupQueueSummarySources(queue);
  }
}

async function dropAbortedFollowups(
  items: FollowupRun[],
  runFollowup: (run: FollowupRun) => Promise<void>,
): Promise<number> {
  let dropped = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (isFollowupRunAborted(item)) {
      await runFollowup(item);
      completeFollowupRunLifecycle(item);
      items.splice(index, 1);
      dropped += 1;
    }
  }
  return dropped;
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
  const key = channelRouteCompactKey({ channel, to, accountId, threadId });
  return key ? { key } : { cross: true };
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
        const droppedBeforeDebounce = await dropAbortedFollowups(queue.items, effectiveRunFollowup);
        if (droppedBeforeDebounce > 0 && queue.items.length === 0) {
          clearFollowupQueueSummaryState(queue);
        }
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        await waitForQueueDebounce(queue);
        const droppedAfterDebounce = await dropAbortedFollowups(queue.items, effectiveRunFollowup);
        if (droppedAfterDebounce > 0 && queue.items.length === 0) {
          clearFollowupQueueSummaryState(queue);
        }
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        if (queue.mode === "collect") {
          // Once the batch is mixed, never collect again within this drain.
          // Prevents “collect after shift” collapsing different targets.
          //
          // Debug: `pnpm test src/auto-reply/reply/reply-flow.test.ts`
          // Check if messages span multiple channels.
          // If so, process individually to preserve per-message routing.
          const isCrossChannel =
            hasCrossChannelItems(queue.items, resolveCrossChannelKey) ||
            queue.items.some(hasRuntimeOnlyFollowupMetadata);

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
              await runWithSummarySourceCleanup(queue, async () => {
                await effectiveRunFollowup({
                  prompt: summaryOnlyPrompt,
                  run,
                  enqueuedAt: Date.now(),
                  ...collectSummaryRuntimeMetadata([]),
                  ...collectQueuedImages(queue.items),
                });
              });
              clearFollowupQueueSummaryState(queue);
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
            await runWithSummarySourceCleanup(queue, async () => {
              await effectiveRunFollowup({
                prompt: summary,
                run,
                enqueuedAt: Date.now(),
                ...collectSummaryRuntimeMetadata([]),
              });
            });
            clearFollowupQueueSummaryState(queue);
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
            const drainGroup = async () => {
              await effectiveRunFollowup({
                prompt,
                run,
                enqueuedAt: Date.now(),
                ...routing,
                ...collectRuntimeMetadata(groupItems),
                ...collectQueuedImages(groupItems),
              });
            };
            if (pendingSummary) {
              await runWithSummarySourceCleanup(queue, drainGroup);
            } else {
              await drainGroup();
            }
            queue.items.splice(0, groupItems.length);
            if (pendingSummary) {
              clearFollowupQueueSummaryState(queue);
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
              await runWithSummarySourceCleanup(queue, async () => {
                await effectiveRunFollowup({
                  prompt: summaryPrompt,
                  run,
                  enqueuedAt: Date.now(),
                  originatingChannel: item.originatingChannel,
                  originatingTo: item.originatingTo,
                  originatingAccountId: item.originatingAccountId,
                  originatingThreadId: item.originatingThreadId,
                  ...collectSummaryRuntimeMetadata([item]),
                  ...collectQueuedImages([item]),
                });
              });
            }))
          ) {
            break;
          }
          clearFollowupQueueSummaryState(queue);
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
        // Only remove the map entry if it still points to this queue instance.
        // clearSessionQueues can replace the entry mid-drain; deleting
        // unconditionally would orphan the replacement queue.
        if (FOLLOWUP_QUEUES.get(key) === queue) {
          FOLLOWUP_QUEUES.delete(key);
          clearFollowupDrainCallback(key);
        }
      } else {
        scheduleFollowupDrain(key, effectiveRunFollowup);
      }
    }
  })();
}
