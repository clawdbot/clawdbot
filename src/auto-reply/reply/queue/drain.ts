import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runAgentHarnessBeforeMessageWriteHook } from "../../../agents/harness/hook-helpers.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { resolveStorePath } from "../../../config/sessions.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
// Drains queued follow-up runs while preserving route and session identity.
import {
  channelRouteCompactKey,
  channelRouteDedupeKey,
} from "../../../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../../../runtime.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import {
  buildCollectPrompt,
  beginQueueDrain,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  removeQueuedItemsByRef,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import {
  completeFollowupRunLifecycle,
  isFollowupRunAborted,
  isFollowupRunDeferredError,
  type FollowupRun,
} from "./types.js";

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
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
  | "originatingChatId"
  | "originatingReplyToId"
  | "originatingReplyToMode"
  | "originatingChatType"
>;

function resolveOriginRoutingMetadata(items: FollowupRun[]): OriginRoutingMetadata {
  const source =
    items.find((item) => item.originatingChannel && item.originatingTo) ??
    items.find(
      (item) =>
        item.originatingChannel ||
        item.originatingTo ||
        item.originatingAccountId ||
        item.originatingThreadId != null ||
        item.originatingChatId ||
        item.originatingReplyToId ||
        item.originatingReplyToMode ||
        item.originatingChatType,
    );
  if (!source) {
    return {};
  }
  return {
    originatingChannel: source.originatingChannel,
    originatingTo: source.originatingTo,
    originatingAccountId: source.originatingAccountId,
    originatingThreadId: source.originatingThreadId,
    originatingChatId: source.originatingChatId,
    originatingReplyToId: source.originatingReplyToId,
    originatingReplyToMode: source.originatingReplyToMode,
    originatingChatType: source.originatingChatType,
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
    JSON.stringify(run.channelContext ?? null),
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

export function resolveFollowupDeliveryContextKey(run: FollowupRun): string {
  const execution = run.run;
  const provenance = execution.inputProvenance;
  return JSON.stringify([
    channelRouteDedupeKey({
      channel: run.originatingChannel,
      to: run.originatingTo,
      accountId: run.originatingAccountId,
      threadId: run.originatingThreadId,
    }),
    run.originatingChatId ?? "",
    resolveFollowupReplyAnchor(run) ?? "",
    run.originatingReplyToMode ?? "",
    normalizeChatType(run.originatingChatType) ?? "",
    resolveFollowupAuthorizationKey(execution),
    normalizeOptionalString(execution.runtimePolicySessionKey ?? execution.sessionKey) ?? "",
    execution.messageProvider ?? "",
    execution.chatType ?? "",
    execution.agentAccountId ?? "",
    execution.groupId ?? "",
    execution.groupChannel ?? "",
    execution.groupSpace ?? "",
    execution.traceAuthorized === true,
    execution.elevatedLevel ?? "",
    provenance?.kind ?? "",
    provenance?.originSessionId ?? "",
    provenance?.sourceSessionKey ?? "",
    provenance?.sourceChannel ?? "",
    provenance?.sourceTool ?? "",
    execution.extraSystemPrompt ?? "",
    execution.extraSystemPromptStatic ?? "",
    execution.sourceReplyDeliveryMode ?? "",
    execution.silentReplyPromptMode ?? "",
    execution.enforceFinalTag === true,
    execution.skipProviderRuntimeHints === true,
    execution.silentExpected === true,
    execution.allowEmptyAssistantReplyAsSilent === true,
    execution.suppressNextUserMessagePersistence === true,
    execution.suppressTranscriptOnlyAssistantPersistence === true,
    execution.blockReplyBreak,
  ]);
}

export function resolveFollowupReplyAnchor(run: FollowupRun): string | undefined {
  return run.originatingReplyToMode === "off"
    ? undefined
    : normalizeOptionalString(run.originatingReplyToId);
}

function splitCollectItemsByDeliveryContext(items: FollowupRun[]): FollowupRun[][] {
  if (items.length <= 1) {
    return items.length === 0 ? [] : [items];
  }

  const groups: FollowupRun[][] = [];
  let currentGroup: FollowupRun[] = [];
  let currentKey: string | undefined;

  for (const item of items) {
    const itemKey = resolveFollowupDeliveryContextKey(item);
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

function hasMixedSummarySourceContexts(items: FollowupRun[]): boolean {
  return (
    items.length > 1 &&
    (hasCrossChannelItems(items, resolveCrossChannelKey) ||
      splitCollectItemsByAuthorization(items).length > 1 ||
      items.some(hasRuntimeOnlyFollowupMetadata))
  );
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
  | "currentInboundAudio"
  | "currentInboundContext"
  | "abortSignal"
  | "deliveryCorrelations"
  | "queuedLifecycle"
  | "queuedDeliveryPayloadTransform"
  | "queuedDeliveryReplyToMode"
  | "queuedDeliveryPayloadDidDeliver"
  | "queuedExecutionContext"
>;

function hasCurrentTurnRuntimeMetadata(item: FollowupRun): boolean {
  return (
    item.currentInboundEventKind === "room_event" ||
    item.currentInboundAudio === true ||
    Boolean(item.currentInboundContext)
  );
}

function hasRuntimeOnlyFollowupMetadata(item: FollowupRun): boolean {
  return Boolean(
    hasCurrentTurnRuntimeMetadata(item) ||
    item.abortSignal ||
    item.deliveryCorrelations?.length ||
    item.queuedLifecycle ||
    item.queuedDeliveryPayloadTransform ||
    item.queuedDeliveryReplyToMode ||
    item.queuedDeliveryPayloadDidDeliver ||
    item.queuedExecutionContext,
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
    currentInboundAudio: currentTurnSource?.currentInboundAudio,
    currentInboundContext: currentTurnSource?.currentInboundContext,
    abortSignal,
    deliveryCorrelations: deliveryCorrelations.length > 0 ? deliveryCorrelations : undefined,
    queuedLifecycle:
      singletonOwner?.queuedLifecycle ??
      (items.length === 1 ? lifecycleSource?.queuedLifecycle : undefined),
    queuedDeliveryPayloadTransform:
      singletonOwner?.queuedDeliveryPayloadTransform ??
      (items.length === 1 ? items[0]?.queuedDeliveryPayloadTransform : undefined),
    queuedDeliveryReplyToMode:
      singletonOwner?.queuedDeliveryReplyToMode ??
      (items.length === 1 ? items[0]?.queuedDeliveryReplyToMode : undefined),
    queuedDeliveryPayloadDidDeliver:
      singletonOwner?.queuedDeliveryPayloadDidDeliver ??
      (items.length === 1 ? items[0]?.queuedDeliveryPayloadDidDeliver : undefined),
    queuedExecutionContext:
      singletonOwner?.queuedExecutionContext ??
      (items.length === 1 ? items[0]?.queuedExecutionContext : undefined),
  };
}

type FollowupQueueSummaryState = {
  dropPolicy: "summarize" | "old" | "new";
  droppedCount: number;
  summaryLines: string[];
  summarySources: FollowupRun[];
  summaryElisions: Array<{
    contextKey: string;
    count: number;
    source: FollowupRun;
    sourceRefs: WeakSet<FollowupRun>;
  }>;
  evictedSummaryCount: number;
};

function clearFollowupQueueSummaryState(queue: FollowupQueueSummaryState): void {
  completeFollowupQueueSummarySources(queue);
  for (const entry of queue.summaryElisions) {
    completeFollowupRunLifecycle(entry.source);
  }
  queue.summaryElisions = [];
  queue.evictedSummaryCount = 0;
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

type QueueSummaryDelivery = {
  prompt: string;
  droppedCount: number;
  sources: FollowupRun[];
};

function createQueueSummaryDelivery(params: {
  queue: FollowupQueueSummaryState;
  sources?: FollowupRun[];
}): QueueSummaryDelivery | undefined {
  const sources = params.sources ? [...params.sources] : [...params.queue.summarySources];
  if (
    params.sources &&
    !sources.every((source, index) => params.queue.summarySources[index] === source)
  ) {
    return undefined;
  }
  const droppedCount = params.sources ? sources.length : params.queue.droppedCount;
  const summaryLines = params.sources
    ? params.queue.summaryLines.slice(0, sources.length)
    : [...params.queue.summaryLines];
  const prompt = previewQueueSummaryPrompt({
    state: {
      dropPolicy: params.queue.dropPolicy,
      droppedCount,
      summaryLines,
    },
    noun: "message",
  });
  if (!prompt) {
    return undefined;
  }
  return {
    prompt,
    droppedCount,
    sources,
  };
}

function consumeQueueSummaryDelivery(
  queue: FollowupQueueSummaryState,
  delivery: QueueSummaryDelivery,
): void {
  let consumedCount = delivery.sources.length === 0 ? delivery.droppedCount : 0;
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    if (sourceIndex >= 0) {
      queue.summarySources.splice(sourceIndex, 1);
      queue.summaryLines.splice(sourceIndex, 1);
      consumedCount += 1;
    } else {
      const elisionIndex = queue.summaryElisions.findIndex((entry) => entry.sourceRefs.has(source));
      if (elisionIndex >= 0) {
        const entry = queue.summaryElisions[elisionIndex];
        entry.count = Math.max(0, entry.count - 1);
        consumedCount += 1;
        if (entry.count === 0) {
          queue.summaryElisions.splice(elisionIndex, 1);
        }
      }
    }
    completeFollowupRunLifecycle(source);
  }
  queue.droppedCount = Math.max(0, queue.droppedCount - consumedCount);
}

function releaseQueueSummaryDeliveryForRetry(
  queue: FollowupQueueSummaryState,
  delivery: QueueSummaryDelivery,
): void {
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    if (sourceIndex >= 0) {
      queue.summarySources[sourceIndex] = createOverflowSummaryRetrySource(source);
    }
    completeFollowupRunLifecycle(source);
  }
}

async function runQueueSummaryDelivery(
  queue: FollowupQueueSummaryState,
  delivery: QueueSummaryDelivery,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!isFollowupRunDeferredError(err)) {
      releaseQueueSummaryDeliveryForRetry(queue, delivery);
    }
    throw err;
  }
  consumeQueueSummaryDelivery(queue, delivery);
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
  const replyToId = resolveFollowupReplyAnchor(item);
  const chatType = normalizeChatType(item.originatingChatType);
  if (
    !channel &&
    !to &&
    !accountId &&
    (threadId == null || threadId === "") &&
    !item.originatingChatId &&
    !replyToId
  ) {
    return chatType ? { key: JSON.stringify(["unresolved", chatType]) } : {};
  }
  if (!isRoutableChannel(channel) || !to) {
    return { cross: true };
  }
  const key = channelRouteCompactKey({ channel, to, accountId, threadId });
  return key
    ? {
        key: JSON.stringify([
          key,
          replyToId ?? "",
          item.originatingReplyToMode ?? "",
          chatType ?? "",
        ]),
      }
    : { cross: true };
}

function resolveOverflowSummarySourceGroup(queue: {
  summarySources: FollowupRun[];
}): FollowupRun[] {
  const source = queue.summarySources[0];
  if (!source) {
    return [];
  }
  const contextKey = resolveFollowupDeliveryContextKey(source);
  const sources: FollowupRun[] = [];
  for (const candidate of queue.summarySources) {
    if (resolveFollowupDeliveryContextKey(candidate) !== contextKey) {
      break;
    }
    sources.push(candidate);
  }
  return sources;
}

export function createOverflowSummaryRetrySource(source: FollowupRun): FollowupRun {
  return {
    prompt: source.prompt,
    transcriptPrompt: source.transcriptPrompt,
    messageId: source.messageId,
    summaryLine: source.summaryLine,
    enqueuedAt: source.enqueuedAt,
    originatingChannel: source.originatingChannel,
    originatingTo: source.originatingTo,
    originatingAccountId: source.originatingAccountId,
    originatingThreadId: source.originatingThreadId,
    originatingChatId: source.originatingChatId,
    originatingReplyToId: source.originatingReplyToId,
    originatingReplyToMode: source.originatingReplyToMode,
    originatingChatType: source.originatingChatType,
    run: source.run,
  };
}

async function runSyntheticOverflowSummary(params: {
  source: FollowupRun;
  prompt: string;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<void> {
  const promptHash = createHash("sha256").update(params.prompt).digest("hex");
  const routeHash = createHash("sha256")
    .update(
      JSON.stringify([
        channelRouteDedupeKey({
          channel: params.source.originatingChannel,
          to: params.source.originatingTo,
          accountId: params.source.originatingAccountId,
          threadId: params.source.originatingThreadId,
        }),
        resolveFollowupReplyAnchor(params.source) ?? "",
        params.source.originatingReplyToMode ?? "",
        normalizeChatType(params.source.originatingChatType) ?? "",
      ]),
    )
    .digest("hex");
  const sessionKey = normalizeOptionalString(params.source.run.sessionKey);
  const storePath = sessionKey
    ? resolveStorePath(params.source.run.config.session?.store, {
        agentId: params.source.run.agentId,
      })
    : undefined;
  const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
    input: {
      text: params.prompt,
      idempotencyKey: `followup-overflow:${params.source.run.sessionId}:${routeHash}:${params.source.messageId ?? params.source.enqueuedAt}:${promptHash}`,
      provenance: params.source.run.inputProvenance,
    },
    target: () => {
      if (!sessionKey || !storePath) {
        return {
          transcriptPath: params.source.run.sessionFile,
          sessionId: params.source.run.sessionId,
          agentId: params.source.run.agentId,
          sessionKey: params.source.run.sessionId,
          cwd: params.source.run.cwd ?? params.source.run.workspaceDir,
          config: params.source.run.config,
        };
      }
      const sessionEntry = loadSessionEntry({
        storePath,
        sessionKey,
        clone: false,
      });
      return {
        sessionId: sessionEntry?.sessionId ?? params.source.run.sessionId,
        sessionKey,
        sessionEntry,
        storePath,
        agentId: params.source.run.agentId,
        cwd: params.source.run.cwd ?? params.source.run.workspaceDir,
        config: params.source.run.config,
      };
    },
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    errorContext: "followup overflow summary transcript",
  });
  await params.runFollowup({
    prompt: params.prompt,
    transcriptPrompt: params.prompt,
    messageId: params.source.messageId,
    userTurnTranscriptRecorder,
    run: params.source.run,
    enqueuedAt: Date.now(),
    ...resolveOriginRoutingMetadata([params.source]),
  });
}

async function drainElidedOverflowSummary(params: {
  queue: FollowupQueueSummaryState;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<boolean> {
  const entry = params.queue.summaryElisions[0];
  if (!entry) {
    return false;
  }
  const retainedSources =
    params.queue.summaryElisions.length === 1
      ? resolveOverflowSummarySourceGroup(params.queue).filter(
          (source) => resolveFollowupDeliveryContextKey(source) === entry.contextKey,
        )
      : [];
  const source = retainedSources.at(-1) ?? entry.source;
  const elidedCount = entry.count;
  const droppedCount = elidedCount + retainedSources.length;
  const summaryLines = params.queue.summaryLines.slice(0, retainedSources.length);
  const prompt = previewQueueSummaryPrompt({
    state: {
      dropPolicy: params.queue.dropPolicy,
      droppedCount,
      summaryLines,
    },
    noun: "message",
  });
  if (!prompt) {
    return false;
  }
  await runQueueSummaryDelivery(
    params.queue,
    {
      prompt,
      droppedCount: retainedSources.length,
      sources: retainedSources,
    },
    async () => {
      await runSyntheticOverflowSummary({
        source,
        prompt,
        runFollowup: params.runFollowup,
      });
    },
  );
  const entryIndex = params.queue.summaryElisions.indexOf(entry);
  if (entryIndex < 0) {
    return true;
  }
  const consumedCount = Math.min(elidedCount, entry.count);
  entry.count -= consumedCount;
  params.queue.droppedCount = Math.max(0, params.queue.droppedCount - consumedCount);
  if (entry.count === 0) {
    params.queue.summaryElisions.splice(entryIndex, 1);
  }
  return true;
}

async function drainOverflowSummaryGroup(params: {
  queue: FollowupQueueSummaryState;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<boolean> {
  if (params.queue.evictedSummaryCount > 0) {
    const evictedCount = params.queue.evictedSummaryCount;
    params.queue.evictedSummaryCount = 0;
    params.queue.droppedCount = Math.max(0, params.queue.droppedCount - evictedCount);
    defaultRuntime.error?.(
      `followup queue omitted ${evictedCount} route-isolated overflow summar${evictedCount === 1 ? "y" : "ies"} after reaching the summary context cap`,
    );
    return true;
  }
  if (await drainElidedOverflowSummary(params)) {
    return true;
  }
  const sources = resolveOverflowSummarySourceGroup(params.queue);
  const source = sources.at(-1);
  if (!source) {
    return false;
  }
  const delivery = createQueueSummaryDelivery({
    queue: params.queue,
    sources,
  });
  if (!delivery) {
    return false;
  }
  await runQueueSummaryDelivery(params.queue, delivery, async () => {
    await runSyntheticOverflowSummary({
      source,
      prompt: delivery.prompt,
      runFollowup: params.runFollowup,
    });
  });
  return true;
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const existingQueue = FOLLOWUP_QUEUES.get(key);
  if (existingQueue?.draining) {
    // The active drain keeps its current callback, but deferred retries must
    // use the latest session/runtime context supplied by the finishing run.
    rememberFollowupDrainCallback(key, runFollowup);
    return;
  }
  const queue = beginQueueDrain(FOLLOWUP_QUEUES, key);
  if (!queue) {
    return;
  }
  const effectiveRunFollowup = FOLLOWUP_RUN_CALLBACKS.get(key) ?? runFollowup;
  // Cache callback only when a drain actually starts. Avoid keeping stale
  // callbacks around from finalize calls where no queue work is pending.
  rememberFollowupDrainCallback(key, effectiveRunFollowup);
  void (async () => {
    let retryDeferred = false;
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
        if (
          queue.droppedCount > 0 &&
          (await drainOverflowSummaryGroup({
            queue,
            runFollowup: effectiveRunFollowup,
          }))
        ) {
          continue;
        }
        if (queue.mode === "collect") {
          // Once the batch is mixed, never collect again within this drain.
          // Prevents “collect after shift” collapsing different targets.
          //
          // Debug: `pnpm test src/auto-reply/reply/reply-flow.test.ts`
          // Check if messages span multiple channels.
          // If so, process individually to preserve per-message routing.
          // Retained overflow sources still own their original route and auth
          // context. Drain live items first when combining them would deliver a
          // summary through a different owner.
          const summarySources = queue.summarySources ?? [];
          const isCrossChannel =
            hasCrossChannelItems(queue.items, resolveCrossChannelKey) ||
            queue.items.some(hasRuntimeOnlyFollowupMetadata) ||
            hasMixedSummarySourceContexts(summarySources) ||
            summarySources.some(hasRuntimeOnlyFollowupMetadata) ||
            (summarySources.length > 0 &&
              hasCrossChannelItems([...queue.items, ...summarySources], resolveCrossChannelKey));
          if (collectState.forceIndividualCollect && !isCrossChannel && queue.items.length > 1) {
            collectState.forceIndividualCollect = false;
          }

          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel,
            items: queue.items,
            run: effectiveRunFollowup,
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }

          const items = queue.items.slice();
          const contextGroups = splitCollectItemsByDeliveryContext(items);
          if (contextGroups.length === 0) {
            break;
          }

          for (const groupItems of contextGroups) {
            const groupSource = groupItems.at(-1);
            const run = groupSource?.run ?? queue.lastRun;
            if (!run) {
              break;
            }

            const routing = resolveOriginRoutingMetadata(groupItems);
            const prompt = buildCollectPrompt({
              title: "[Queued messages while agent was busy]",
              items: groupItems,
              renderItem: renderCollectItem,
            });
            const drainGroup = async () => {
              await effectiveRunFollowup({
                prompt,
                run,
                messageId:
                  groupSource?.messageId ??
                  (groupSource ? resolveFollowupReplyAnchor(groupSource) : undefined),
                enqueuedAt: Date.now(),
                ...routing,
                ...collectRuntimeMetadata(groupItems),
                ...collectQueuedImages(groupItems),
              });
            };
            await drainGroup();
            removeQueuedItemsByRef(queue.items, groupItems);
          }
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, effectiveRunFollowup))) {
          break;
        }
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
      if (isFollowupRunDeferredError(err)) {
        retryDeferred = true;
      } else {
        defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
      }
    } finally {
      queue.draining = false;
      const hasPendingQueueWork = queue.items.length > 0 || queue.droppedCount > 0;
      if (retryDeferred && hasPendingQueueWork) {
        scheduleFollowupDrain(key, effectiveRunFollowup);
      } else if (!hasPendingQueueWork) {
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
