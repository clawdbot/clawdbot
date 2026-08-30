// Enqueues follow-up reply runs and schedules queue drains.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { logMessageQueuedWithBacklogPolicy } from "../../../logging/diagnostic-runtime.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  applyQueueDropPolicy,
  countPendingQueueItems,
  shouldSkipQueueItem,
} from "../../../utils/queue-helpers.js";
import { resolveFollowupReplyDeliveryTargetKey } from "./delivery-target.js";
import {
  clearFollowupDrainCallback,
  createOverflowSummaryRetrySource,
  kickFollowupDrainIfIdle,
  rememberFollowupDrainCallback,
  resolveFollowupDeliveryContextKey,
} from "./drain.js";
import {
  peekRecentQueueMessageId,
  recordRecentQueueMessageId,
  resetRecentQueuedMessageIdDedupe,
} from "./recent-message-ids.js";
import {
  FOLLOWUP_QUEUES,
  getExistingFollowupQueue,
  getFollowupQueue,
  trimSummaryElisionsToCap,
} from "./state.js";
import {
  completeFollowupRunLifecycle,
  isFollowupRunAborted,
  markFollowupRunEnqueued,
  type EnqueueFollowupRunOptions,
  type FollowupRun,
  type QueueDedupeMode,
  type QueueSettings,
} from "./types.js";

function followupRouteIdentityKey(run: FollowupRun): string {
  return resolveFollowupReplyDeliveryTargetKey(run);
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

function appendQueueItem(params: {
  key: string;
  queue: ReturnType<typeof getFollowupQueue>;
  run: FollowupRun;
  recentMessageIdKey?: string;
  runFollowup?: (run: FollowupRun) => Promise<void>;
  restartIfIdle: boolean;
  front: boolean;
}): void {
  params.queue.lastEnqueuedAt = Date.now();
  params.queue.lastRun = params.run.run;
  params.run.queueAbortSignal = params.queue.abortController.signal;
  params.queue.items[params.front ? "unshift" : "push"](params.run);
  if (params.recentMessageIdKey) {
    recordRecentQueueMessageId(params.run, params.recentMessageIdKey);
  }
  if (params.runFollowup) {
    rememberFollowupDrainCallback(params.key, params.runFollowup);
  }
  if (params.restartIfIdle && !params.queue.draining) {
    kickFollowupDrainIfIdle(params.key);
  }
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
  runFollowup?: (run: FollowupRun) => Promise<void>,
  restartIfIdle = true,
  options: EnqueueFollowupRunOptions = {},
): boolean {
  if (isFollowupRunAborted(run)) {
    return false;
  }
  if (options.position === "front") {
    run.protectFromQueueOverflow = true;
  }
  if (options.steerCandidate) {
    run.steerAnchor = true;
  }
  // Peek before getFollowupQueue: rejecting a redelivery after the original
  // queue drained and self-deleted must not recreate an empty registry entry,
  // which nothing would ever delete again.
  const recentMessageIdKey = dedupeMode !== "none" ? buildRecentMessageIdKey(run, key) : undefined;
  if (recentMessageIdKey && peekRecentQueueMessageId(recentMessageIdKey)) {
    return false;
  }
  const queue = getFollowupQueue(key, settings);

  const dedupe =
    dedupeMode === "none"
      ? undefined
      : (item: FollowupRun, items: FollowupRun[]) =>
          isRunAlreadyQueued(item, items, dedupeMode === "prompt");

  // Deduplicate: skip if the same message is already queued.
  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
    return false;
  }
  if (options.steerCandidate) {
    if (!markFollowupRunEnqueued(run)) {
      return false;
    }
    const { promise: acceptance, resolve: settle } = createDeferredCore<boolean>();
    run.steerPending = { predecessor: queue.steerAcceptanceTail, settle };
    queue.steerAcceptanceTail = acceptance;
    appendQueueItem({
      key,
      queue,
      run,
      recentMessageIdKey,
      runFollowup,
      restartIfIdle,
      front: options.position === "front",
    });
    return true;
  }
  // A later normal/interrupt prompt cannot be dropped while an older steer is
  // deciding between same-turn delivery and fallback. Append it behind the
  // anchor; ordinary overflow policy resumes as soon as the gate resolves.
  if (queue.items.some((item) => item.steerPending)) {
    if (!markFollowupRunEnqueued(run)) {
      return false;
    }
    appendQueueItem({
      key,
      queue,
      run,
      recentMessageIdKey,
      runFollowup,
      restartIfIdle,
      front: false,
    });
    return true;
  }
  // drop:new rejects this source without mutating the existing queue. Do not
  // publish an external queued identity for work that will never be admitted.
  const pendingCount = countPendingQueueItems(queue.items, queue.inFlight);
  if (
    !options.steerCandidate &&
    queue.dropPolicy === "new" &&
    queue.cap > 0 &&
    pendingCount >= queue.cap
  ) {
    run.onQueueDisposition?.("queue-cap-new");
    completeFollowupRunLifecycle(run);
    return false;
  }
  if (!markFollowupRunEnqueued(run)) {
    return false;
  }

  const elidedSummaryLines: string[] = [];
  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    inFlight: queue.inFlight,
    summarize: (item) => normalizeOptionalString(item.summaryLine) || item.prompt.trim(),
    onSummaryElide: (lines) => elidedSummaryLines.push(...lines),
    onDrop: (dropped) => {
      if (queue.dropPolicy === "summarize") {
        queue.summarySources.push(...dropped);
        return;
      }
      for (const item of dropped) {
        item.onQueueDisposition?.("queue-cap-old");
        completeFollowupRunLifecycle(item);
      }
    },
    isProtected: (item) => item.protectFromQueueOverflow === true || item.steerAnchor === true,
  });
  if (queue.dropPolicy === "summarize") {
    const overflow = queue.summarySources.length - queue.summaryLines.length;
    if (overflow > 0) {
      const removed = queue.summarySources.splice(0, overflow);
      for (const [index, item] of removed.entries()) {
        const summaryLine = elidedSummaryLines[index];
        if (summaryLine === undefined) {
          throw new Error("followup queue summary source lost its elided line");
        }
        const contextKey = resolveFollowupDeliveryContextKey(item);
        const lastElision = queue.summaryElisions.at(-1);
        if (lastElision?.contextKey === contextKey) {
          const compactSource = createOverflowSummaryRetrySource(item);
          lastElision.count += 1;
          lastElision.sources.push(compactSource);
          lastElision.summaryLines.push(summaryLine);
          lastElision.sourceRefs.set(item, compactSource);
          if (queue.activeSummarySources.has(item)) {
            queue.activeSummarySources.add(compactSource);
          }
        } else {
          const compactSource = createOverflowSummaryRetrySource(item);
          queue.summaryElisions.push({
            contextKey,
            count: 1,
            sources: [compactSource],
            summaryLines: [summaryLine],
            sourceRefs: new WeakMap([[item, compactSource]]),
          });
          if (queue.activeSummarySources.has(item)) {
            queue.activeSummarySources.add(compactSource);
          }
        }
        trimSummaryElisionsToCap(queue);
      }
    }
  }
  if (!shouldEnqueue) {
    run.onQueueDisposition?.("queue-cap");
    completeFollowupRunLifecycle(run);
    return false;
  }
  appendQueueItem({
    key,
    queue,
    run,
    recentMessageIdKey,
    runFollowup,
    restartIfIdle,
    front: options.position === "front",
  });
  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const queue = getExistingFollowupQueue(key);
  if (!queue) {
    return 0;
  }
  return countPendingQueueItems(queue.items, queue.inFlight);
}

function settleParkedSteerAcceptance(key: string, run: FollowupRun, accepted: boolean): boolean {
  const queue = getExistingFollowupQueue(key);
  const pending = run.steerPending;
  if (!queue?.items.includes(run) || !pending) {
    return false;
  }
  pending.settle(accepted);
  if (!accepted) {
    delete run.steerPending;
    reapplyDeferredOverflow(key);
    kickFollowupDrainIfIdle(key);
  }
  return true;
}

function isParkedFollowupRunOwned(key: string, run: FollowupRun): boolean {
  return getExistingFollowupQueue(key)?.items.includes(run) === true;
}

function reapplyDeferredOverflow(key: string): void {
  const queue = getExistingFollowupQueue(key);
  if (!queue || queue.items.some((item) => item.steerPending)) {
    return;
  }
  const lastAnchor = queue.items.findLastIndex((item) => item.steerAnchor === true);
  const suffix = queue.items.splice(lastAnchor + 1);
  if (suffix.length === 0) {
    return;
  }
  const originalCap = queue.cap;
  const settings: QueueSettings = {
    mode: queue.mode,
    debounceMs: queue.debounceMs,
    cap: originalCap + lastAnchor + 1,
    dropPolicy: queue.dropPolicy,
  };
  for (const item of suffix) {
    if (!enqueueFollowupRun(key, item, settings, "none", undefined, false)) {
      completeFollowupRunLifecycle(item);
    }
  }
  queue.cap = originalCap;
}

/** Remove an exactly committed steer while preserving every sibling's FIFO position. */
function consumeParkedFollowupRun(key: string, run: FollowupRun): boolean {
  const queue = getExistingFollowupQueue(key);
  const index = queue?.items.indexOf(run) ?? -1;
  if (!queue || index < 0) {
    return false;
  }
  queue.items.splice(index, 1);
  run.steerPending?.settle(true);
  delete run.steerPending;
  delete run.protectFromQueueOverflow;
  delete run.steerAnchor;
  reapplyDeferredOverflow(key);
  completeFollowupRunLifecycle(run);
  if (
    !queue.draining &&
    queue.items.length === 0 &&
    queue.inFlight.size === 0 &&
    queue.droppedCount === 0 &&
    FOLLOWUP_QUEUES.get(key) === queue
  ) {
    FOLLOWUP_QUEUES.delete(key);
    clearFollowupDrainCallback(key);
  } else {
    kickFollowupDrainIfIdle(key);
  }
  return true;
}

type ParkedSteerReservation = {
  admit: () => Promise<"steer" | "fallback" | "cancelled">;
  accepted: (accepted: boolean) => void;
  fallback: () => void;
  consume: () => void;
};

export function parkSteerCandidate(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  runFollowup: (run: FollowupRun) => Promise<void>,
): ParkedSteerReservation | undefined {
  if (
    !enqueueFollowupRun(key, run, settings, "message-id", runFollowup, false, {
      steerCandidate: true,
    })
  ) {
    return undefined;
  }
  logMessageQueuedWithBacklogPolicy(
    {
      sessionId: run.run.sessionId,
      sessionKey: key,
      channel: run.originatingChannel ?? run.run.messageProvider,
      source: "followup-queue-steer",
    },
    false,
  );
  return {
    async admit() {
      const predecessorAccepted = (await run.steerPending?.predecessor) ?? true;
      if (isFollowupRunAborted(run) || !isParkedFollowupRunOwned(key, run)) {
        return "cancelled";
      }
      return predecessorAccepted ? "steer" : "fallback";
    },
    accepted: (accepted) => settleParkedSteerAcceptance(key, run, accepted),
    fallback: () => settleParkedSteerAcceptance(key, run, false),
    consume: () => consumeParkedFollowupRun(key, run),
  };
}

if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.queueEnqueueTestApi")] = {
    resetRecentQueuedMessageIdDedupe,
  };
}
