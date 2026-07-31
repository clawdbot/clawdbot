import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runAgentHarnessBeforeMessageWriteHook } from "../../../agents/harness/hook-helpers.js";
import { stableStringify } from "../../../agents/stable-stringify.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { resolveStorePath } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
// Drains queued follow-up runs while preserving route and session identity.
import {
  channelRouteCompactKey,
  channelRouteDedupeKey,
} from "../../../plugin-sdk/channel-route.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  createUserTurnTranscriptRecorder,
} from "../../../sessions/user-turn-transcript.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import {
  buildCollectPrompt,
  beginQueueDrain,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  removeQueuedItemsByRef,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES, trimSummaryElisionsToCap } from "./state.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  isFollowupRunAborted,
  isFollowupRunDeferredError,
  retireFollowupRunCancellation,
  type FollowupRun,
} from "./types.js";

// Persists the most recent runFollowup callback per queue key so that
// enqueueFollowupRun can restart a drain that finished and deleted the queue.
const FOLLOWUP_DRAIN_CALLBACKS_KEY = Symbol.for("openclaw.followupDrainCallbacks");

const FOLLOWUP_RUN_CALLBACKS = resolveGlobalMap<string, (run: FollowupRun) => Promise<void>>(
  FOLLOWUP_DRAIN_CALLBACKS_KEY,
);

const QUEUED_ADMISSION_OWNER_STATE_KEY = Symbol.for("openclaw.queuedAdmissionOwnerState");
const queuedAdmissionOwnerState = resolveGlobalSingleton(QUEUED_ADMISSION_OWNER_STATE_KEY, () => ({
  keys: new WeakMap<NonNullable<FollowupRun["turnAdoptionLifecycle"]>, string>(),
  nextId: 1,
}));

function hasExclusiveTurnAdmission(
  lifecycle: FollowupRun["turnAdoptionLifecycle"],
): lifecycle is NonNullable<FollowupRun["turnAdoptionLifecycle"]> & {
  admission: "exclusive";
} {
  return lifecycle?.admission === "exclusive";
}

function resolveTurnAdoptionLifecycleDeliveryKey(
  lifecycle: FollowupRun["turnAdoptionLifecycle"],
): string {
  if (!lifecycle) {
    return "";
  }
  const explicitOwnerKey = lifecycle.ownerKey ?? "";
  // Closed admission marker — never infer exclusive from onAbandoned presence.
  // Cancel-only owners share collect identity via ownerKey alone.
  if (!hasExclusiveTurnAdmission(lifecycle)) {
    return explicitOwnerKey;
  }
  let admissionOwnerKey = queuedAdmissionOwnerState.keys.get(lifecycle);
  if (!admissionOwnerKey) {
    admissionOwnerKey = `admission:${queuedAdmissionOwnerState.nextId++}`;
    queuedAdmissionOwnerState.keys.set(lifecycle, admissionOwnerKey);
  }
  // Durable admission callbacks own separate ingress identities. Combining
  // them would let one source commit before a sibling rejects the aggregate.
  return JSON.stringify([explicitOwnerKey, admissionOwnerKey]);
}

function assertSingleAdmissionOwner(items: readonly FollowupRun[]): void {
  const owners = new Set(
    items.flatMap((item) =>
      hasExclusiveTurnAdmission(item.turnAdoptionLifecycle) ? [item.turnAdoptionLifecycle] : [],
    ),
  );
  if (owners.size > 1) {
    throw new Error("followup queue cannot aggregate distinct admission lifecycles");
  }
}

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
function resolveFollowupAuthorizationKey(run: FollowupRun["run"]): string {
  return JSON.stringify([
    run.senderId ?? "",
    JSON.stringify(run.channelContext ?? null),
    run.senderE164 ?? "",
    run.senderIsOwner === true,
    run.execOverrides?.host ?? "",
    run.execOverrides?.security ?? "",
    run.execOverrides?.ask ?? "",
    run.execOverrides?.node ?? "",
    run.execOverrides?.nodeCwd ?? "",
    run.bashElevated?.enabled === true,
    run.bashElevated?.allowed === true,
    run.bashElevated?.defaultLevel ?? "",
    run.approvalReviewerDeviceId ?? "",
  ]);
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
    run.turnAdoptionLifecycle?.ownerKey ?? "",
    normalizeOptionalString(execution.runtimePolicySessionKey ?? execution.sessionKey) ?? "",
    execution.messageProvider ?? "",
    JSON.stringify([...new Set(execution.clientCaps ?? [])].toSorted()),
    stableStringify(execution.toolBindings ?? null),
    execution.chatType ?? "",
    execution.agentAccountId ?? "",
    execution.groupId ?? "",
    execution.groupChannel ?? "",
    execution.groupSpace ?? "",
    execution.spawnedBy ?? "",
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
    execution.taskSuggestionDeliveryMode ?? "",
    execution.silentReplyPromptMode ?? "",
    execution.enforceFinalTag === true,
    execution.skipProviderRuntimeHints === true,
    execution.silentExpected === true,
    execution.allowEmptyAssistantReplyAsSilent === true,
    execution.suppressNextUserMessagePersistence === true,
    execution.suppressTranscriptOnlyAssistantPersistence === true,
    execution.blockReplyBreak,
    resolveTurnAdoptionLifecycleDeliveryKey(run.turnAdoptionLifecycle),
  ]);
}

export function resolveFollowupReplyAnchor(run: FollowupRun): string | undefined {
  if (run.originatingReplyToMode === "off") {
    return undefined;
  }
  const replyToId = normalizeOptionalString(run.originatingReplyToId);
  if (replyToId || normalizeMessageChannel(run.originatingChannel) !== "slack") {
    return replyToId;
  }
  const threadId = run.originatingThreadId;
  const hasRoutedThread =
    typeof threadId === "number"
      ? Number.isFinite(threadId)
      : normalizeOptionalString(threadId) !== undefined;
  // Slack standalone turns have no parent reply id, but enabled reply policies
  // still need the message id so collect groups cannot cross independent roots.
  // A routed thread already owns that boundary and remains collectable across turns.
  return hasRoutedThread ? undefined : normalizeOptionalString(run.messageId);
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

function renderCollectItem(item: FollowupRun, idx: number): string {
  return renderCollectItemPrompt(item, idx, item.prompt);
}

function renderCollectItemPrompt(item: FollowupRun, idx: number, prompt: string): string {
  const senderLabel =
    item.run.senderName ?? item.run.senderUsername ?? item.run.senderId ?? item.run.senderE164;
  const senderSuffix = senderLabel ? ` (from ${senderLabel})` : "";
  return `---\nQueued #${idx + 1}${senderSuffix}\n${prompt}`.trim();
}

function collectQueuedPromptMedia(
  items: FollowupRun[],
): Pick<FollowupRun, "images" | "imageOrder" | "media"> {
  const images: NonNullable<FollowupRun["images"]> = [];
  const imageOrder: NonNullable<FollowupRun["imageOrder"]> = [];
  const media: NonNullable<FollowupRun["media"]> = [];
  for (const item of items) {
    if (item.images) {
      images.push(...item.images);
    }
    if (item.imageOrder) {
      imageOrder.push(...item.imageOrder);
    }
    if (item.media) {
      media.push(...item.media);
    }
  }
  return {
    ...(images.length > 0 ? { images } : {}),
    ...(imageOrder.length > 0 ? { imageOrder } : {}),
    ...(media.length > 0 ? { media } : {}),
  };
}

type FollowupRuntimeMetadata = Pick<
  FollowupRun,
  | "currentInboundEventKind"
  | "currentInboundAudio"
  | "currentInboundContext"
  | "abortSignal"
  | "queueAbortSignal"
  | "deliveryCorrelations"
  | "turnAdoptionLifecycle"
  | "onReplyAdmissionWaitChange"
>;

function hasCurrentTurnRuntimeMetadata(item: FollowupRun): boolean {
  return (
    item.currentInboundEventKind === "room_event" ||
    item.currentInboundAudio === true ||
    Boolean(item.currentInboundContext)
  );
}

function hasRuntimeOnlyFollowupMetadata(item: FollowupRun): boolean {
  return item.currentInboundEventKind === "room_event" || item.currentInboundAudio === true;
}

function buildCollectTranscriptPrompt(items: FollowupRun[]): string {
  return buildCollectPrompt({
    title: "[Queued messages while agent was busy]",
    items,
    renderItem: (item, index) =>
      renderCollectItemPrompt(item, index, item.transcriptPrompt ?? item.prompt),
  });
}

function resolveFollowupTranscriptTarget(source: FollowupRun) {
  const sessionKey = normalizeOptionalString(source.run.sessionKey) ?? source.run.sessionId;
  const storePath = resolveStorePath(source.run.config.session?.store, {
    agentId: source.run.agentId,
  });
  const sessionEntry = loadSessionEntryReadOnly({
    storePath,
    sessionKey,
    clone: false,
  });
  return {
    sessionId: sessionEntry?.sessionId ?? source.run.sessionId,
    sessionKey,
    sessionEntry,
    storePath,
    agentId: source.run.agentId,
    cwd: source.run.cwd ?? source.run.workspaceDir,
    config: source.run.config,
  };
}

function createCollectUserTurnTranscriptRecorder(items: FollowupRun[]) {
  const transcriptSources = items.filter((item) => item.userTurnTranscriptRecorder);
  const source = transcriptSources.at(-1);
  if (!source) {
    return undefined;
  }
  const buildInput = async () => {
    const messages = await Promise.all(
      transcriptSources.map(
        async (item) => await item.userTurnTranscriptRecorder?.resolveMessage(),
      ),
    );
    const media = messages.flatMap((message) =>
      buildPersistedUserTurnMediaInputsFromFields(message),
    );
    const timestamp = messages.reduce<number | undefined>((latest, message) => {
      const candidate = message?.timestamp;
      return typeof candidate === "number" && (latest === undefined || candidate > latest)
        ? candidate
        : latest;
    }, undefined);
    const transcriptPrompt = buildCollectTranscriptPrompt(transcriptSources);
    const identityHash = createHash("sha256")
      .update(
        JSON.stringify(
          transcriptSources.map((item) => [
            item.messageId ?? "",
            item.enqueuedAt,
            item.transcriptPrompt,
          ]),
        ),
      )
      .digest("hex");
    return {
      text: transcriptPrompt,
      senderIsOwner: source.run.senderIsOwner,
      provenance: source.run.inputProvenance,
      idempotencyKey: `followup-collect:${source.run.sessionId}:${identityHash}`,
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(media.length === 0 ? {} : { media }),
    };
  };
  const initialTranscriptPrompt = buildCollectTranscriptPrompt(transcriptSources);
  return createUserTurnTranscriptRecorder({
    input: {
      text: initialTranscriptPrompt,
      senderIsOwner: source.run.senderIsOwner,
      provenance: source.run.inputProvenance,
    },
    resolveInput: buildInput,
    target: () => resolveFollowupTranscriptTarget(source),
    errorContext: "collected followup user turn transcript",
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
  });
}

function resolveAggregateOwner(items: readonly FollowupRun[]): FollowupRun | undefined {
  // Keep the latest cancelable source as the aggregate owner even when a
  // later transport-only source has no cancellation identity.
  return (
    items.findLast((item) => item.abortSignal) ??
    items.findLast((item) => item.turnAdoptionLifecycle) ??
    items.at(-1)
  );
}

function requiresIndividualCollectDrain(item: FollowupRun): boolean {
  return item.disableCollectBatching === true || hasRuntimeOnlyFollowupMetadata(item);
}

type AggregateCancellation = {
  signal?: AbortSignal;
  admit: () => void;
  dispose: () => void;
};

function createAggregateCancellation(items: readonly FollowupRun[]): AggregateCancellation {
  const owner = resolveAggregateOwner(items);
  const sourceSignals = new Map<AbortSignal, Set<FollowupRun>>();
  for (const item of items) {
    if (!item.abortSignal) {
      continue;
    }
    const owners = sourceSignals.get(item.abortSignal) ?? new Set<FollowupRun>();
    owners.add(item);
    sourceSignals.set(item.abortSignal, owners);
  }
  const signals = new Set(sourceSignals.keys());
  if (signals.size === 0) {
    return {
      signal: undefined,
      admit: () => undefined,
      dispose: () => undefined,
    };
  }
  const onlySignal = signals.size === 1 ? signals.values().next().value : undefined;
  const onlySignalOwned =
    onlySignal && owner ? sourceSignals.get(onlySignal)?.has(owner) === true : false;
  if (onlySignal && onlySignalOwned) {
    return {
      signal: onlySignal,
      admit: () => undefined,
      dispose: () => undefined,
    };
  }
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of signals) {
    const abort = () => controller.abort();
    listeners.set(signal, abort);
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  const disposeSignal = (signal: AbortSignal) => {
    const listener = listeners.get(signal);
    if (!listener) {
      return;
    }
    signal.removeEventListener("abort", listener);
    listeners.delete(signal);
  };
  return {
    signal: controller.signal,
    admit: () => {
      // Before admission every source remains independently cancellable. Once
      // atomic, only the latest source owns aggregate client cancellation.
      for (const [signal, sourceOwners] of sourceSignals) {
        if (!owner || !sourceOwners.has(owner)) {
          disposeSignal(signal);
        }
      }
    },
    dispose: () => {
      for (const signal of listeners.keys()) {
        disposeSignal(signal);
      }
    },
  };
}

function collectCurrentInboundContext(items: FollowupRun[]): FollowupRun["currentInboundContext"] {
  const contexts = items.flatMap((item, index) =>
    item.currentInboundContext ? [{ context: item.currentInboundContext, index }] : [],
  );
  if (contexts.length === 0) {
    return undefined;
  }
  if (contexts.length === 1) {
    return contexts[0]?.context;
  }
  const renderField = (field: "text" | "resumableText") => {
    const blocks = contexts.flatMap(({ context, index }) => {
      const value = context[field];
      return value ? [`Queued #${index + 1} context:\n${value}`] : [];
    });
    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  };
  const text = renderField("text");
  if (!text) {
    return undefined;
  }
  const resumableText = renderField("resumableText");
  const injectedGoalContexts = [
    ...new Set(contexts.flatMap(({ context }) => context.injectedGoalContexts ?? [])),
  ];
  return {
    text,
    ...(resumableText ? { resumableText } : {}),
    promptJoiner: "\n\n",
    ...(injectedGoalContexts.length > 0 ? { injectedGoalContexts } : {}),
  };
}

function collectRuntimeMetadata(
  items: FollowupRun[],
  abortSignal?: AbortSignal,
): FollowupRuntimeMetadata {
  const currentTurnSource = items.find(hasCurrentTurnRuntimeMetadata);
  const deliveryCorrelations = items.flatMap((item) => item.deliveryCorrelations ?? []);
  const admissionWaitCallbacks = new Set(
    items.flatMap((item) =>
      item.onReplyAdmissionWaitChange ? [item.onReplyAdmissionWaitChange] : [],
    ),
  );
  return {
    currentInboundEventKind: currentTurnSource?.currentInboundEventKind,
    currentInboundAudio: currentTurnSource?.currentInboundAudio,
    currentInboundContext: collectCurrentInboundContext(items),
    abortSignal,
    queueAbortSignal: items.find((item) => item.queueAbortSignal)?.queueAbortSignal,
    deliveryCorrelations: deliveryCorrelations.length > 0 ? deliveryCorrelations : undefined,
    turnAdoptionLifecycle: items.length === 1 ? items[0]?.turnAdoptionLifecycle : undefined,
    onReplyAdmissionWaitChange:
      admissionWaitCallbacks.size > 0
        ? (waiting) => {
            for (const callback of admissionWaitCallbacks) {
              callback(waiting);
            }
          }
        : undefined,
  };
}

type FollowupQueueSummaryState = {
  cap: number;
  dropPolicy: "summarize" | "old" | "new";
  droppedCount: number;
  summaryLines: string[];
  summarySources: FollowupRun[];
  activeSummarySources: WeakSet<FollowupRun>;
  summaryElisions: Array<{
    contextKey: string;
    count: number;
    sources: FollowupRun[];
    sourceRefs: WeakMap<FollowupRun, FollowupRun>;
  }>;
  evictedSummaryCount: number;
};

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
  completeLifecycles = true,
): void {
  let consumedCount = delivery.sources.length === 0 ? delivery.droppedCount : 0;
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    if (sourceIndex >= 0) {
      queue.summarySources.splice(sourceIndex, 1);
      queue.summaryLines.splice(sourceIndex, 1);
      consumedCount += 1;
    } else {
      const elisionIndex = queue.summaryElisions.findIndex(
        (entry) => entry.sources.includes(source) || entry.sourceRefs.has(source),
      );
      if (elisionIndex >= 0) {
        const entry = expectDefined(
          queue.summaryElisions[elisionIndex],
          "summary elisions entry at elision index",
        );
        const elidedSourceIndex = entry.sources.indexOf(entry.sourceRefs.get(source) ?? source);
        entry.sources.splice(elidedSourceIndex, 1);
        entry.count = entry.sources.length;
        consumedCount += 1;
        if (entry.sources.length === 0) {
          queue.summaryElisions.splice(elisionIndex, 1);
        }
      }
    }
    if (completeLifecycles) {
      completeFollowupRunLifecycle(source);
    }
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
    if (!source.turnAdoptionLifecycle) {
      completeFollowupRunLifecycle(source);
    }
  }
}

function dropAbortedQueueSummarySources(queue: FollowupQueueSummaryState): number {
  let dropped = 0;
  for (let index = queue.summarySources.length - 1; index >= 0; index -= 1) {
    const source = expectDefined(queue.summarySources[index], "summary sources entry at index");
    if (!isFollowupRunAborted(source)) {
      continue;
    }
    queue.summarySources.splice(index, 1);
    queue.summaryLines.splice(index, 1);
    queue.droppedCount = Math.max(0, queue.droppedCount - 1);
    completeFollowupRunLifecycle(source);
    dropped += 1;
  }
  return dropped;
}

async function runQueueSummaryDelivery(
  queue: FollowupQueueSummaryState,
  delivery: QueueSummaryDelivery,
  run: (params: {
    abortSignal?: AbortSignal;
    onAdmitted?: () => void | Promise<void>;
  }) => Promise<void>,
  protectedSources: FollowupRun[] = delivery.sources,
): Promise<boolean> {
  assertSingleAdmissionOwner(protectedSources);
  const inheritedActiveSources = new Set(
    protectedSources.filter((source) => queue.activeSummarySources.has(source)),
  );
  for (const source of protectedSources) {
    queue.activeSummarySources.add(source);
  }
  let admitted = false;
  let deferredBeforeAdmission = false;
  const cancellation = createAggregateCancellation(protectedSources);
  const needsAdmission =
    protectedSources.length > 1 ||
    protectedSources.some((source) => hasExclusiveTurnAdmission(source.turnAdoptionLifecycle));
  const onAdmitted = needsAdmission
    ? async () => {
        if (admitted) {
          return;
        }
        await Promise.all(protectedSources.map((source) => admitFollowupRunLifecycle(source)));
        cancellation.admit();
        admitted = true;
        // A multi-source summary is atomic once it owns the reply lane.
        // Retire sibling ids while the latest source owns aggregate cancel.
        consumeQueueSummaryDelivery(queue, { ...delivery, sources: protectedSources }, false);
        const aggregateOwner = resolveAggregateOwner(protectedSources);
        for (const source of protectedSources) {
          if (source !== aggregateOwner) {
            retireFollowupRunCancellation(source);
          }
        }
      }
    : undefined;
  try {
    try {
      await run({ abortSignal: cancellation.signal, onAdmitted });
    } catch (err) {
      if (!admitted) {
        deferredBeforeAdmission = isFollowupRunDeferredError(err);
        if (!deferredBeforeAdmission) {
          releaseQueueSummaryDeliveryForRetry(queue, delivery);
        }
      } else {
        // Admission consumed the aggregate sources, so a failed attempt is
        // terminal for their queue identities rather than retryable queue work.
        for (const source of protectedSources) {
          completeFollowupRunLifecycle(source);
        }
      }
      throw err;
    }
    if (!admitted) {
      const canceledSources = protectedSources.filter(isFollowupRunAborted);
      if (canceledSources.length > 0) {
        consumeQueueSummaryDelivery(queue, {
          ...delivery,
          sources: canceledSources,
        });
        return false;
      }
    }
    if (!admitted) {
      consumeQueueSummaryDelivery(queue, delivery);
    }
    return true;
  } finally {
    cancellation.dispose();
    // Carry one deferred generation across retries. Later retries release newly
    // protected sources so continued overflow cannot grow retained identities.
    const deferredCarryover =
      deferredBeforeAdmission && inheritedActiveSources.size === 0
        ? new Set(protectedSources)
        : inheritedActiveSources;
    for (const source of protectedSources) {
      if (deferredBeforeAdmission && deferredCarryover.has(source)) {
        continue;
      }
      queue.activeSummarySources.delete(source);
      for (const entry of queue.summaryElisions) {
        const compactSource = entry.sourceRefs.get(source);
        if (compactSource) {
          queue.activeSummarySources.delete(compactSource);
        }
      }
    }
    trimSummaryElisionsToCap(queue);
  }
}

async function dropAbortedFollowups(
  items: FollowupRun[],
  runFollowup: (run: FollowupRun) => Promise<void>,
): Promise<number> {
  let dropped = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = expectDefined(items[index], "items entry at index");
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
    // Internal/local transports (notably webchat) have no external destination.
    // Keep their full route identity so matching turns can collect safely.
    return {
      key: JSON.stringify([
        "local",
        channel ?? "",
        to ?? "",
        accountId ?? "",
        threadId ?? "",
        item.originatingChatId ?? "",
        replyToId ?? "",
        item.originatingReplyToMode ?? "",
        chatType ?? "",
      ]),
    };
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

async function drainProtectedPriorityFollowup(
  items: FollowupRun[],
  runFollowup: (run: FollowupRun) => Promise<void>,
): Promise<boolean> {
  const priority = items.find((item) => item.protectFromQueueOverflow === true);
  if (!priority) {
    return false;
  }
  await runFollowup(priority);
  removeQueuedItemsByRef(items, [priority]);
  return true;
}

export function createOverflowSummaryRetrySource(source: FollowupRun): FollowupRun {
  return {
    prompt: source.prompt,
    queueAbortSignal: source.queueAbortSignal,
    transcriptPrompt: source.transcriptPrompt,
    media: source.media,
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
    abortSignal: source.abortSignal,
    turnAdoptionLifecycle: source.turnAdoptionLifecycle,
    onReplyAdmissionWaitChange: source.onReplyAdmissionWaitChange,
    ...(source.currentInboundEventKind === "room_event"
      ? { currentInboundEventKind: "room_event" }
      : {}),
    run: source.run,
  };
}

function resolveOverflowSummaryInboundEventKind(sources: FollowupRun[]): "room_event" | undefined {
  return sources.length > 0 &&
    sources.every((source) => source.currentInboundEventKind === "room_event")
    ? "room_event"
    : undefined;
}

async function runSyntheticOverflowSummary(params: {
  source: FollowupRun;
  sources: FollowupRun[];
  prompt: string;
  abortSignal?: AbortSignal;
  onAdmitted?: () => void | Promise<void>;
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
  const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
    input: {
      text: params.prompt,
      idempotencyKey: `followup-overflow:${params.source.run.sessionId}:${routeHash}:${params.source.messageId ?? params.source.enqueuedAt}:${promptHash}`,
      provenance: params.source.run.inputProvenance,
    },
    target: () => resolveFollowupTranscriptTarget(params.source),
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    errorContext: "followup overflow summary transcript",
  });
  const currentInboundEventKind = resolveOverflowSummaryInboundEventKind(params.sources);
  let admitted = false;
  await params.runFollowup({
    prompt: params.prompt,
    queueAbortSignal: params.source.queueAbortSignal,
    transcriptPrompt: params.prompt,
    messageId: params.source.messageId,
    userTurnTranscriptRecorder,
    run: params.source.run,
    enqueuedAt: Date.now(),
    abortSignal: params.abortSignal,
    onReplyAdmissionWaitChange: collectRuntimeMetadata(params.sources).onReplyAdmissionWaitChange,
    ...(params.onAdmitted
      ? {
          turnAdoptionLifecycle: {
            // Synthetic aggregate owner — not a durable exclusive ingress identity.
            admission: "cancel-only" as const,
            onAdopted: async () => {
              await params.onAdmitted?.();
              admitted = true;
            },
            onSettled: () => {
              if (admitted) {
                for (const source of params.sources) {
                  completeFollowupRunLifecycle(source);
                }
              }
            },
          },
        }
      : {}),
    ...resolveOriginRoutingMetadata([params.source]),
    ...(currentInboundEventKind ? { currentInboundEventKind } : {}),
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
  for (let index = entry.sources.length - 1; index >= 0; index -= 1) {
    const source = expectDefined(entry.sources[index], "sources entry at index");
    if (!isFollowupRunAborted(source)) {
      continue;
    }
    entry.sources.splice(index, 1);
    entry.count = Math.max(0, entry.count - 1);
    params.queue.droppedCount = Math.max(0, params.queue.droppedCount - 1);
    completeFollowupRunLifecycle(source);
  }
  if (entry.sources.length === 0) {
    params.queue.summaryElisions.shift();
    return true;
  }
  const source = retainedSources.at(-1) ?? entry.sources.at(-1);
  if (!source) {
    return false;
  }
  const elidedCount = entry.sources.length;
  const elidedSources = [...entry.sources];
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
  const delivered = await runQueueSummaryDelivery(
    params.queue,
    {
      prompt,
      droppedCount: retainedSources.length,
      sources: retainedSources,
    },
    async ({ abortSignal, onAdmitted }) => {
      await runSyntheticOverflowSummary({
        source,
        sources: [...elidedSources, ...retainedSources],
        prompt,
        abortSignal,
        onAdmitted,
        runFollowup: params.runFollowup,
      });
    },
    [...elidedSources, ...retainedSources],
  );
  if (!delivered) {
    return true;
  }
  const entryIndex = params.queue.summaryElisions.indexOf(entry);
  if (entryIndex < 0) {
    return true;
  }
  const consumedCount = Math.min(elidedCount, entry.sources.length);
  const consumedSources = entry.sources.splice(0, consumedCount);
  entry.count = entry.sources.length;
  for (const consumedSource of consumedSources) {
    completeFollowupRunLifecycle(consumedSource);
  }
  params.queue.droppedCount = Math.max(0, params.queue.droppedCount - consumedCount);
  if (entry.sources.length === 0) {
    params.queue.summaryElisions.splice(entryIndex, 1);
  }
  return true;
}

async function drainOverflowSummaryGroup(params: {
  queue: FollowupQueueSummaryState;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): Promise<boolean> {
  if (dropAbortedQueueSummarySources(params.queue) > 0 && params.queue.droppedCount === 0) {
    return true;
  }
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
  await runQueueSummaryDelivery(params.queue, delivery, async ({ abortSignal, onAdmitted }) => {
    await runSyntheticOverflowSummary({
      source,
      sources: delivery.sources,
      prompt: delivery.prompt,
      abortSignal,
      onAdmitted,
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
  const reserveOptions = {
    inFlight: queue.inFlight,
    shouldRestoreOnError: () =>
      FOLLOWUP_QUEUES.get(key) === queue && !queue.abortController.signal.aborted,
    onDiscard: (item: FollowupRun) => completeFollowupRunLifecycle(item),
  };
  // Cache callback only when a drain actually starts. Avoid keeping stale
  // callbacks around from finalize calls where no queue work is pending.
  rememberFollowupDrainCallback(key, effectiveRunFollowup);
  // Queue drains outlive their enqueue request across debounce and retries.
  // Give the detached chain its own root so inherited request admission cannot go stale.
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    let retryDeferred = false;
    try {
      const collectState = { forceIndividualCollect: false };
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await dropAbortedFollowups(queue.items, effectiveRunFollowup);
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        await waitForQueueDebounce(queue, queue.abortController.signal);
        await dropAbortedFollowups(queue.items, effectiveRunFollowup);
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        if (await drainProtectedPriorityFollowup(queue.items, effectiveRunFollowup)) {
          continue;
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
          const isCrossChannel =
            hasCrossChannelItems(queue.items, resolveCrossChannelKey) ||
            queue.items.some(requiresIndividualCollectDrain);
          if (collectState.forceIndividualCollect && !isCrossChannel && queue.items.length > 1) {
            collectState.forceIndividualCollect = false;
          }

          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel,
            items: queue.items,
            run: effectiveRunFollowup,
            reserveOptions,
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
            // Earlier groups await model work. Recheck membership so overflow
            // eviction cannot leave a stale snapshot eligible for delivery.
            const currentGroupItems = groupItems.filter((item) => queue.items.includes(item));
            const abortedGroupItems = currentGroupItems.filter(isFollowupRunAborted);
            if (abortedGroupItems.length > 0) {
              removeQueuedItemsByRef(queue.items, abortedGroupItems);
              for (const item of abortedGroupItems) {
                completeFollowupRunLifecycle(item);
              }
            }
            const activeGroupItems = currentGroupItems.filter(
              (item) => !isFollowupRunAborted(item),
            );
            if (activeGroupItems.length === 0) {
              continue;
            }
            assertSingleAdmissionOwner(activeGroupItems);
            const groupSource = activeGroupItems.at(-1);
            const run = groupSource?.run ?? queue.lastRun;
            if (!run) {
              break;
            }

            const routing = resolveOriginRoutingMetadata(activeGroupItems);
            const prompt = buildCollectPrompt({
              title: "[Queued messages while agent was busy]",
              items: activeGroupItems,
              renderItem: renderCollectItem,
            });
            const transcriptPrompt = buildCollectTranscriptPrompt(activeGroupItems);
            const userTurnTranscriptRecorder =
              createCollectUserTurnTranscriptRecorder(activeGroupItems);
            const aggregateOwner = resolveAggregateOwner(activeGroupItems);
            const cancellation = createAggregateCancellation(activeGroupItems);
            let admitted = false;
            const restoreGroupItems = (groupItemsToRestore: FollowupRun[]) => {
              const missingItems = groupItemsToRestore.filter(
                (item) => !queue.items.includes(item),
              );
              queue.items.unshift(...missingItems);
            };
            const needsGroupAdmission =
              activeGroupItems.length > 1 ||
              activeGroupItems.some((item) =>
                hasExclusiveTurnAdmission(item.turnAdoptionLifecycle),
              );
            const consumeAdmittedGroup = () => {
              cancellation.admit();
              admitted = true;
              removeQueuedItemsByRef(queue.items, activeGroupItems);
              for (const item of activeGroupItems) {
                if (item !== aggregateOwner) {
                  retireFollowupRunCancellation(item);
                }
              }
            };
            const admitGroupSources = async () => {
              await Promise.all(activeGroupItems.map((item) => admitFollowupRunLifecycle(item)));
              consumeAdmittedGroup();
            };
            const completeGroup = () => {
              removeQueuedItemsByRef(queue.items, activeGroupItems);
              for (const item of activeGroupItems) {
                completeFollowupRunLifecycle(item);
              }
            };
            const drainGroup = async () => {
              await effectiveRunFollowup({
                prompt,
                transcriptPrompt,
                ...(userTurnTranscriptRecorder ? { userTurnTranscriptRecorder } : {}),
                run,
                messageId:
                  groupSource?.messageId ??
                  (groupSource ? resolveFollowupReplyAnchor(groupSource) : undefined),
                enqueuedAt: Date.now(),
                ...routing,
                ...collectRuntimeMetadata(activeGroupItems, cancellation.signal),
                ...(needsGroupAdmission
                  ? {
                      turnAdoptionLifecycle: {
                        // Synthetic aggregate owner — sources keep their own admission.
                        admission: "cancel-only" as const,
                        onAdopted: admitGroupSources,
                        onSettled: () => {
                          if (admitted) {
                            completeGroup();
                          }
                        },
                      },
                    }
                  : {}),
                ...collectQueuedPromptMedia(activeGroupItems),
              });
            };
            try {
              // Mark active group items as in-flight so the drop policy does not
              // select them as overflow victims while the group drain is awaited.
              for (const item of activeGroupItems) {
                queue.inFlight.add(item);
              }
              await drainGroup();
            } catch (err) {
              if (admitted) {
                completeGroup();
              } else if (
                FOLLOWUP_QUEUES.get(key) === queue &&
                !queue.abortController.signal.aborted
              ) {
                restoreGroupItems(activeGroupItems);
              } else {
                for (const item of activeGroupItems) {
                  completeFollowupRunLifecycle(item);
                }
              }
              throw err;
            } finally {
              for (const item of activeGroupItems) {
                queue.inFlight.delete(item);
              }
              cancellation.dispose();
            }
            if (!admitted) {
              const canceledSources = activeGroupItems.filter(isFollowupRunAborted);
              if (canceledSources.length > 0) {
                removeQueuedItemsByRef(queue.items, canceledSources);
                for (const item of canceledSources) {
                  completeFollowupRunLifecycle(item);
                }
                const survivors = activeGroupItems.filter(
                  (item) => !canceledSources.includes(item),
                );
                if (FOLLOWUP_QUEUES.get(key) === queue && !queue.abortController.signal.aborted) {
                  restoreGroupItems(survivors);
                  if (survivors.length > 0) {
                    break;
                  }
                } else {
                  for (const item of survivors) {
                    completeFollowupRunLifecycle(item);
                  }
                }
                continue;
              }
            }
            completeGroup();
          }
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, effectiveRunFollowup, reserveOptions))) {
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
  }).catch((err: unknown) => {
    queue.draining = false;
    defaultRuntime.error?.(`followup queue drain admission failed for ${key}: ${String(err)}`);
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
