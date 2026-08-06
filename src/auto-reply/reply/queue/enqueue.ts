// Enqueues follow-up reply runs and schedules queue drains.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { resolveGlobalDedupeCache } from "../../../infra/dedupe.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { applyQueueDropPolicy, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import {
  createOverflowSummaryRetrySource,
  kickFollowupDrainIfIdle,
  rememberFollowupDrainCallback,
  resolveFollowupDeliveryContextKey,
  resolveFollowupReplyAnchor,
} from "./drain.js";
import { getExistingFollowupQueue, getFollowupQueue } from "./state.js";
import {
  completeFollowupRunLifecycle,
  isFollowupRunAborted,
  markFollowupRunEnqueued,
  type FollowupRun,
  type QueueDedupeMode,
  type QueueSettings,
} from "./types.js";

/**
 * Keep queued message-id dedupe shared across bundled chunks so redeliveries
 * are rejected no matter which chunk receives the enqueue call.
 */
const RECENT_QUEUE_MESSAGE_IDS_KEY = Symbol.for("openclaw.recentQueueMessageIds");

const RECENT_QUEUE_MESSAGE_IDS = resolveGlobalDedupeCache(RECENT_QUEUE_MESSAGE_IDS_KEY, {
  ttlMs: 5 * 60 * 1000,
  maxSize: 10_000,
});

function followupRouteIdentityKey(run: FollowupRun): string {
  return JSON.stringify([
    channelRouteDedupeKey({
      channel: run.originatingChannel,
      to: run.originatingTo,
      accountId: run.originatingAccountId,
      threadId: run.originatingThreadId,
    }),
    resolveFollowupReplyAnchor(run) ?? "",
    run.originatingReplyToMode ?? "",
    normalizeChatType(run.originatingChatType) ?? "",
  ]);
}

function followupMessageRouteIdentityKey(run: FollowupRun): string {
  return JSON.stringify([
    channelRouteDedupeKey({
      channel: run.originatingChannel,
      to: run.originatingTo,
      accountId: run.originatingAccountId,
      threadId: run.originatingThreadId,
    }),
    normalizeChatType(run.originatingChatType) ?? "",
  ]);
}

function buildRecentMessageIdKey(run: FollowupRun, queueKey: string): string | undefined {
  const messageId = normalizeOptionalString(run.messageId);
  if (!messageId) {
    return undefined;
  }
  // Use JSON tuple serialization to avoid delimiter-collision edge cases when
  // channel/to/account values contain "|" characters.
  return JSON.stringify(["queue", queueKey, followupMessageRouteIdentityKey(run), messageId]);
}

function isRunAlreadyQueued(
  run: FollowupRun,
  items: FollowupRun[],
  allowPromptFallback = false,
): boolean {
  const messageId = normalizeOptionalString(run.messageId);
  if (messageId) {
    const messageRouteKey = followupMessageRouteIdentityKey(run);
    return items.some(
      (item) =>
        normalizeOptionalString(item.messageId) === messageId &&
        followupMessageRouteIdentityKey(item) === messageRouteKey,
    );
  }
  if (!allowPromptFallback) {
    return false;
  }
  const routeKey = followupRouteIdentityKey(run);
  return items.some(
    (item) => item.prompt === run.prompt && followupRouteIdentityKey(item) === routeKey,
  );
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
  runFollowup?: (run: FollowupRun) => Promise<void>,
  restartIfIdle = true,
): boolean {
  if (isFollowupRunAborted(run)) {
    return false;
  }
  const queue = getFollowupQueue(key, settings);
  const recentMessageIdKey = dedupeMode !== "none" ? buildRecentMessageIdKey(run, key) : undefined;
  if (recentMessageIdKey && RECENT_QUEUE_MESSAGE_IDS.peek(recentMessageIdKey)) {
    return false;
  }

  const dedupe =
    dedupeMode === "none"
      ? undefined
      : (item: FollowupRun, items: FollowupRun[]) =>
          isRunAlreadyQueued(item, items, dedupeMode === "prompt");

  // Deduplicate: skip if the same message is already queued.
  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
    return false;
  }
  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;

  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => normalizeOptionalString(item.summaryLine) || item.prompt.trim(),
    onDrop: (dropped) => {
      if (queue.dropPolicy === "summarize") {
        queue.summarySources.push(...dropped);
        return;
      }
      for (const item of dropped) {
        completeFollowupRunLifecycle(item);
      }
    },
  });
  if (queue.dropPolicy === "summarize") {
    const overflow = queue.summarySources.length - queue.summaryLines.length;
    if (overflow > 0) {
      const removed = queue.summarySources.splice(0, overflow);
      for (const item of removed) {
        const contextKey = resolveFollowupDeliveryContextKey(item);
        const lastElision = queue.summaryElisions.at(-1);
        if (lastElision?.contextKey === contextKey) {
          lastElision.count += 1;
          lastElision.source = createOverflowSummaryRetrySource(item);
          lastElision.sourceRefs.add(item);
        } else {
          if (queue.summaryElisions.length >= queue.cap) {
            const evicted = queue.summaryElisions.shift();
            if (evicted) {
              queue.evictedSummaryCount += evicted.count;
              completeFollowupRunLifecycle(evicted.source);
            }
          }
          queue.summaryElisions.push({
            contextKey,
            count: 1,
            source: createOverflowSummaryRetrySource(item),
            sourceRefs: new WeakSet([item]),
          });
        }
        completeFollowupRunLifecycle(item);
      }
    }
  }
  if (!shouldEnqueue) {
    return false;
  }

  queue.items.push(run);
  markFollowupRunEnqueued(run);
  if (recentMessageIdKey) {
    RECENT_QUEUE_MESSAGE_IDS.check(recentMessageIdKey);
  }
  if (runFollowup) {
    rememberFollowupDrainCallback(key, runFollowup);
  }
  // If drain finished and deleted the queue before this item arrived, a new queue
  // object was created (draining: false) but nobody scheduled a drain for it.
  // Use the cached callback to restart the drain now.
  if (restartIfIdle && !queue.draining) {
    kickFollowupDrainIfIdle(key);
  }
  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const queue = getExistingFollowupQueue(key);
  if (!queue) {
    return 0;
  }
  return queue.items.length;
}

export function resetRecentQueuedMessageIdDedupe(): void {
  RECENT_QUEUE_MESSAGE_IDS.clear();
}
