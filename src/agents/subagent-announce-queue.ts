import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { defaultRuntime } from "../runtime.js";
import { deliveryContextKey, normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  applyQueueRuntimeSettings,
  applyQueueDropPolicy,
  beginQueueDrain,
  buildCollectPrompt,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../utils/queue-helpers.js";
import type { AgentInternalEvent } from "./internal-events.js";

export type AnnounceQueueItem = {
  // Stable announce identity shared by direct + queued delivery paths.
  // Optional for backward compatibility with previously queued items.
  announceId?: string;
  prompt: string;
  summaryLine?: string;
  internalEvents?: AgentInternalEvent[];
  enqueuedAt: number;
  sessionKey: string;
  origin?: DeliveryContext;
  originKey?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
};

type AnnounceQueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

type AnnounceQueueState = {
  items: AnnounceQueueItem[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  send: (item: AnnounceQueueItem) => Promise<void>;
  /** Return true while the target parent session is still busy and delivery should wait. */
  shouldDefer?: (item: AnnounceQueueItem) => boolean;
  /** Consecutive drain failures — drives exponential backoff on errors. */
  consecutiveFailures: number;
};

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueueState>();
const MAX_DEFER_WHILE_BUSY_MS = 15_000;

export function resetAnnounceQueuesForTests() {
  // Test isolation: other suites may leave a draining queue behind in the worker.
  // Clearing the map alone isn't enough because drain loops capture `queue` by reference.
  for (const queue of ANNOUNCE_QUEUES.values()) {
    queue.items.length = 0;
    queue.summaryLines.length = 0;
    queue.droppedCount = 0;
    queue.lastEnqueuedAt = 0;
  }
  ANNOUNCE_QUEUES.clear();
}

function getAnnounceQueue(
  key: string,
  settings: AnnounceQueueSettings,
  send: (item: AnnounceQueueItem) => Promise<void>,
  shouldDefer?: (item: AnnounceQueueItem) => boolean,
) {
  const existing = ANNOUNCE_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    existing.send = send;
    if (shouldDefer !== undefined) {
      existing.shouldDefer = shouldDefer;
    }
    return existing;
  }
  const created: AnnounceQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs: typeof settings.debounceMs === "number" ? Math.max(0, settings.debounceMs) : 1000,
    cap: typeof settings.cap === "number" && settings.cap > 0 ? Math.floor(settings.cap) : 20,
    dropPolicy: settings.dropPolicy ?? "summarize",
    droppedCount: 0,
    summaryLines: [],
    send,
    shouldDefer,
    consecutiveFailures: 0,
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  ANNOUNCE_QUEUES.set(key, created);
  return created;
}

function resolveAnnounceAuthorizationKey(item: AnnounceQueueItem): string {
  return JSON.stringify([item.sessionKey, item.originKey ?? ""]);
}

function splitCollectItemsByAuthorization(items: AnnounceQueueItem[]): AnnounceQueueItem[][] {
  if (items.length <= 1) {
    return items.length === 0 ? [] : [items];
  }

  const groups: AnnounceQueueItem[][] = [];
  let currentGroup: AnnounceQueueItem[] = [];
  let currentKey: string | undefined;

  for (const item of items) {
    const itemKey = resolveAnnounceAuthorizationKey(item);
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

function hasAnnounceCrossChannelItems(items: AnnounceQueueItem[]): boolean {
  return hasCrossChannelItems(items, (item) => {
    if (!item.origin) {
      return {};
    }
    if (!item.originKey) {
      return { cross: true };
    }
    return { key: item.originKey };
  });
}

function shouldDeferAnnounceQueueItem(queue: AnnounceQueueState, item: AnnounceQueueItem): boolean {
  if (!queue.shouldDefer?.(item)) {
    return false;
  }
  return Date.now() - item.enqueuedAt < MAX_DEFER_WHILE_BUSY_MS;
}

function waitBeforeDeferredAnnounceRetry(queue: AnnounceQueueState): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(250, queue.debounceMs));
    timer.unref?.();
  });
}

function scheduleAnnounceDrain(key: string) {
  const queue = beginQueueDrain(ANNOUNCE_QUEUES, key);
  if (!queue) {
    return;
  }
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: false };
      for (;;) {
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        await waitForQueueDebounce(queue);
        const nextItem = queue.items[0];
        if (nextItem && shouldDeferAnnounceQueueItem(queue, nextItem)) {
          await waitBeforeDeferredAnnounceRetry(queue);
          queue.lastEnqueuedAt = Date.now() - queue.debounceMs;
          continue;
        }
        if (queue.mode === "collect") {
          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel: hasAnnounceCrossChannelItems(queue.items),
            items: queue.items,
            run: async (item) => await queue.send(item),
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }
          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
          const authGroups = splitCollectItemsByAuthorization(items);
          if (authGroups.length === 0) {
            break;
          }

          let pendingSummary = summary;
          for (const groupItems of authGroups) {
            const prompt = buildCollectPrompt({
              title: "[Queued announce messages while agent was busy]",
              items: groupItems,
              summary: pendingSummary,
              renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
            });
            const internalEvents = groupItems.flatMap((item) => item.internalEvents ?? []);
            const last = groupItems.at(-1);
            if (!last) {
              break;
            }
            await queue.send({
              ...last,
              prompt,
              internalEvents: internalEvents.length > 0 ? internalEvents : last.internalEvents,
            });
            queue.items.splice(0, groupItems.length);
            if (pendingSummary) {
              clearQueueSummaryState(queue);
              pendingSummary = undefined;
            }
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
        if (summaryPrompt) {
          if (
            !(await drainNextQueueItem(
              queue.items,
              async (item) => await queue.send({ ...item, prompt: summaryPrompt }),
            ))
          ) {
            break;
          }
          clearQueueSummaryState(queue);
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, async (item) => await queue.send(item)))) {
          break;
        }
      }
      // Drain succeeded — reset failure counter.
      queue.consecutiveFailures = 0;
    } catch (err) {
      queue.consecutiveFailures++;
      // Exponential backoff on consecutive failures: 2s, 4s, 8s, ... capped at 60s.
      const errorBackoffMs = Math.min(1000 * 2 ** queue.consecutiveFailures, 60_000);
      const retryDelayMs = Math.max(errorBackoffMs, queue.debounceMs);
      queue.lastEnqueuedAt = Date.now() + retryDelayMs - queue.debounceMs;
      defaultRuntime.error?.(
        `announce queue drain failed for ${key} (attempt ${queue.consecutiveFailures}, retry in ${Math.round(retryDelayMs / 1000)}s): ${String(err)}`,
      );
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        ANNOUNCE_QUEUES.delete(key);
      } else {
        scheduleAnnounceDrain(key);
      }
    }
  })();
}

export function enqueueAnnounce(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
  shouldDefer?: (item: AnnounceQueueItem) => boolean;
}): boolean {
  const queue = getAnnounceQueue(params.key, params.settings, params.send, params.shouldDefer);
  // Preserve any retry backoff marker already encoded in lastEnqueuedAt.
  queue.lastEnqueuedAt = Math.max(queue.lastEnqueuedAt, Date.now());

  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) {
    if (queue.dropPolicy === "new") {
      scheduleAnnounceDrain(params.key);
    }
    return false;
  }

  const origin = normalizeDeliveryContext(params.item.origin);
  const originKey = deliveryContextKey(origin);
  queue.items.push({ ...params.item, origin, originKey });
  scheduleAnnounceDrain(params.key);
  return true;
}
