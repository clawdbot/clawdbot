// Dispatches final reply payloads through visible senders and message tools.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
} from "../../infra/delivery-recovery.shared.js";
import { collectErrorGraphCandidates, toErrorObject } from "../../infra/errors.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { sleep } from "../../utils.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import {
  normalizeReplyPayloadOutcome,
  type NormalizeReplyOutcome,
  type NormalizeReplySkipReason,
} from "./normalize-reply.js";
import {
  composeReplyDispatchBeforeDeliver,
  DEFAULT_BEFORE_DELIVER_TIMEOUT_MS,
  markReplyDispatchBeforeDeliverDeadlineOwned,
  runReplyDispatchBeforeDeliverStage,
} from "./reply-dispatch-before-deliver.js";
import { getHumanDelay, getHumanDelayMax } from "./reply-dispatch-delay.js";
import {
  createReplyDispatchSettledCounts,
  REPLY_DISPATCH_OUTCOME_COUNTS,
  resolveReplyDispatchDeliveryOutcome,
  shouldRetryReplyDispatch,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatch-outcome.js";
import {
  mapReplyDispatchCounts,
  type ReplyDispatchBeforeDeliver,
  type ReplyDispatchBeforeDeliverOptions,
  type ReplyDispatchKind,
  type ReplyDispatchReceipt,
  type ReplyDispatchRuntimeInfo,
  type ReplyDispatchSettledCounts,
  type ReplyDispatcher,
  type ReplyFollowupAdmissionBarrierTimeoutPolicy,
} from "./reply-dispatcher.types.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import type { TypingController } from "./typing.js";

type ReplyDispatchErrorHandler = (
  err: unknown,
  info: ReplyDispatchRuntimeInfo,
) => Promise<void> | void;

type ReplyDispatchSkipHandler = (
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo & { reason: NormalizeReplySkipReason },
) => void;

type ReplyDispatchCancelHandler = (
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
) => Promise<void> | void;

export type { ReplyDispatchDeliveryOutcome };

function isRetryableNoSendFailure(error: unknown): boolean {
  return (
    isProvenDeliveryNotSentError(error) &&
    !findPlatformMessageRejectedError(error) &&
    !collectErrorGraphCandidates(error, (candidate) => [
      candidate.cause,
      candidate.original,
      candidate.error,
      candidate.reason,
      ...(Array.isArray(candidate.errors) ? candidate.errors : []),
    ]).some(
      (candidate) =>
        isRecord(candidate) &&
        (candidate.sentBeforeError === true ||
          candidate.visibleReplySent === true ||
          (isRecord(candidate.deliveryResult) &&
            candidate.deliveryResult.visibleReplySent === true)),
    )
  );
}

type ReplyDispatchDeliveryOutcomeTracker = {
  promise: Promise<ReplyDispatchDeliveryOutcome>;
  resolve: (outcome: ReplyDispatchDeliveryOutcome) => void;
  tracked: boolean;
};

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
) => Promise<unknown>;

export type { ReplyDispatchBeforeDeliver };
export { composeReplyDispatchBeforeDeliver, markReplyDispatchBeforeDeliverDeadlineOwned };

const silentReplyLogger = createSubsystemLogger("silent-reply/dispatcher");
const deliveryOutcomeTrackers = new WeakMap<ReplyPayload, ReplyDispatchDeliveryOutcomeTracker>();
const undeliveredFallbacks = new WeakMap<ReplyPayload, ReplyPayload>();
const conversationContextsByDispatcher = new WeakMap<ReplyDispatcher, string>();
const replyDispatcherPreparers = new WeakMap<
  ReplyDispatcher,
  {
    owner: object;
    normalize: (kind: ReplyDispatchKind, payload: ReplyPayload) => NormalizeReplyOutcome;
  }
>();

/** Associate this turn's finalized prompt with its exact dispatcher without changing the SDK. */
export function bindReplyDispatcherConversationContext(
  dispatcher: ReplyDispatcher,
  conversationContext: string,
): void {
  conversationContextsByDispatcher.set(dispatcher, conversationContext);
}

/** Capture one core-dispatcher delivery outcome without changing send* return types. */
export function captureReplyDispatchDeliveryOutcome(payload: ReplyPayload): {
  promise: Promise<ReplyDispatchDeliveryOutcome>;
  isTracked: () => boolean;
} {
  let resolveOutcome!: (outcome: ReplyDispatchDeliveryOutcome) => void;
  const tracker: ReplyDispatchDeliveryOutcomeTracker = {
    promise: new Promise((resolve) => {
      resolveOutcome = resolve;
    }),
    resolve: (outcome) => resolveOutcome(outcome),
    tracked: false,
  };
  deliveryOutcomeTrackers.set(payload, tracker);
  return { promise: tracker.promise, isTracked: () => tracker.tracked };
}

/** Attach a text alternative that is delivered only when the primary payload is proven unsent. */
export function attachReplyDispatchUndeliveredFallback(
  payload: ReplyPayload,
  fallback: ReplyPayload,
): void {
  undeliveredFallbacks.set(payload, fallback);
}

function buildReplyDispatchRuntimeInfo(
  payload: ReplyPayload,
  kind: ReplyDispatchKind,
): ReplyDispatchRuntimeInfo {
  const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
  return { kind, ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}) };
}

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  silentReplyContext?: {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
  };
  responsePrefix?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  /** Static context for response prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
  /** Dynamic context provider for response prefix template interpolation.
   * Called at normalization time, after model selection is complete. */
  responsePrefixContextProvider?: () => ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  onIdle?: () => Promise<void> | void;
  onError?: ReplyDispatchErrorHandler;
  /** Let a durable ingress owner retry when every attempted send proves no recipient visibility. */
  propagateRetryableNoSendFailure?: boolean;
  // AIDEV-NOTE: onSkip lets channels detect silent/empty drops (e.g. Telegram empty-response fallback).
  onSkip?: ReplyDispatchSkipHandler;
  /** Human-like delay between block replies for natural rhythm. */
  humanDelay?: HumanDelayConfig;
  beforeDeliver?: ReplyDispatchBeforeDeliver;
  /** Owner-declared deadline for the constructor before-delivery callback. */
  beforeDeliverOptions?: ReplyDispatchBeforeDeliverOptions;
  onBeforeDeliverCancelled?: ReplyDispatchCancelHandler;
  /** Observe each queued payload settling, including cancellation and delivery failure. */
  onDeliverySettled?: (info: ReplyDispatchRuntimeInfo) => void;
  /** Resolve an owner activity policy for holding queued follow-ups behind delivery. */
  resolveFollowupAdmissionBarrierTimeoutPolicy?: (context: {
    queuedCounts: Readonly<Record<ReplyDispatchKind, number>>;
    humanDelayBudgetMs: number;
  }) => ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined;
};

export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  typingCallbacks?: TypingCallbacks;
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => Promise<void> | void;
  onSettled?: () => unknown;
  onFreshSettledDelivery?: () => unknown;
  /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
  onCleanup?: () => void;
};

type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
  markDispatchIdle: () => void;
  /** Signal that the model run is complete so the typing controller can stop. */
  markRunComplete: () => void;
};

type NormalizeReplyPayloadInternalOptions = Pick<
  ReplyDispatcherOptions,
  | "responsePrefix"
  | "responsePrefixContext"
  | "responsePrefixContextProvider"
  | "onHeartbeatStrip"
  | "transformReplyPayload"
> & {
  conversationContext?: string;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

function normalizeReplyPayloadInternal(
  payload: ReplyPayload,
  opts: NormalizeReplyPayloadInternalOptions,
): NormalizeReplyOutcome {
  // Prefer dynamic context provider over static context
  const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;

  return normalizeReplyPayloadOutcome(payload, {
    responsePrefix: opts.responsePrefix,
    responsePrefixContext: prefixContext,
    onHeartbeatStrip: opts.onHeartbeatStrip,
    transformReplyPayload: opts.transformReplyPayload,
    conversationContext: opts.conversationContext,
    onSkip: opts.onSkip,
  });
}

/** Normalize through a dispatcher's exact owner before TTS or other visible side effects. */
export function prepareReplyPayloadForDispatcher(
  dispatcher: ReplyDispatcher,
  kind: ReplyDispatchKind,
  payload: ReplyPayload,
): NormalizeReplyOutcome {
  const preparer = replyDispatcherPreparers.get(dispatcher);
  if (!preparer) {
    return { kind: "deliver", payload };
  }
  const outcome = preparer.normalize(kind, payload);
  return outcome.kind === "deliver"
    ? {
        kind: "deliver",
        payload: setReplyPayloadMetadata(outcome.payload, {
          replyDispatcherNormalizationOwner: preparer.owner,
        }),
      }
    : outcome;
}

export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  let beforeDeliver = composeReplyDispatchBeforeDeliver(
    options.beforeDeliver
      ? { hook: options.beforeDeliver, options: options.beforeDeliverOptions }
      : undefined,
  );
  // Track in-flight deliveries so we can emit a reliable "idle" signal.
  // Start with pending=1 as a "reservation" to prevent premature gateway restart.
  // This is decremented when markComplete() is called to signal no more replies will come.
  let pending = 1;
  let completeCalled = false;
  // Track whether we've sent a block reply (for human delay - skip delay on first block).
  let sentFirstBlock = false;
  // Serialize outbound replies to preserve tool/block/final order.
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const settledCounts: Record<ReplyDispatchKind, ReplyDispatchSettledCounts> = {
    tool: createReplyDispatchSettledCounts(),
    block: createReplyDispatchSettledCounts(),
    final: createReplyDispatchSettledCounts(),
  };
  let retryableNoSendError: Error | undefined;
  let sendChain: Promise<void> = Promise.resolve();
  let settlementChain: Promise<void> = Promise.resolve();
  let pendingFinalizations = 0;
  let idleNotified = false;
  const ignoreResult = () => undefined;
  const notifyIdle = () => {
    if (idleNotified) {
      return;
    }
    idleNotified = true;
    try {
      void Promise.resolve(options.onIdle?.()).catch(ignoreResult);
    } catch {}
  };
  const scheduleDelivery = <T>(run: () => Promise<T>): Promise<T> => {
    idleNotified = false;
    const delivery = sendChain.then(run);
    sendChain = delivery.then(ignoreResult, ignoreResult);
    const drained = sendChain;
    void drained.then(() => drained === sendChain && pendingFinalizations > 0 && notifyIdle());
    return delivery;
  };
  const enqueueSettlement = (settle: () => Promise<void>) =>
    (settlementChain = settlementChain.then(settle));
  const waitForIdle = async () => {
    let sent: Promise<void>;
    let settled: Promise<void>;
    do {
      sent = sendChain;
      settled = settlementChain;
      await Promise.all([sent, settled]);
    } while (sent !== sendChain || settled !== settlementChain);
  };

  const buildReceipt = (): ReplyDispatchReceipt => ({
    counts: {
      tool: { ...settledCounts.tool },
      block: { ...settledCounts.block },
      final: { ...settledCounts.final },
    },
    anyVisibleDelivered: Object.values(settledCounts).some(
      (counts) => counts.delivered > 0 || counts.failedAfterSend > 0,
    ),
  });

  const { unregister } = registerDispatcher({
    pending: () => pending,
    waitForIdle,
  });

  const reportObserverError = (err: unknown, info: ReplyDispatchRuntimeInfo) => {
    void Promise.resolve(options.onError?.(err, info)).catch(() => undefined);
  };

  const normalizeForDispatch = (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    notifySkip: boolean,
  ) =>
    normalizeReplyPayloadInternal(payload, {
      responsePrefix: options.responsePrefix,
      responsePrefixContext: options.responsePrefixContext,
      responsePrefixContextProvider: options.responsePrefixContextProvider,
      transformReplyPayload: options.transformReplyPayload,
      conversationContext: conversationContextsByDispatcher.get(dispatcher),
      onHeartbeatStrip: options.onHeartbeatStrip,
      onSkip: notifySkip
        ? (reason) =>
            options.onSkip?.(payload, {
              ...buildReplyDispatchRuntimeInfo(payload, kind),
              reason,
            })
        : undefined,
    });

  const notifyBeforeDeliverCancelled = async (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ) => {
    const observer = options.onBeforeDeliverCancelled;
    if (!observer) {
      return;
    }
    try {
      await runReplyDispatchBeforeDeliverStage(
        {
          hook: async (current, currentInfo) => {
            await observer(current, currentInfo);
            return current;
          },
          timeoutMs: DEFAULT_BEFORE_DELIVER_TIMEOUT_MS,
        },
        payload,
        info,
      );
    } catch (err: unknown) {
      reportObserverError(err, info);
    }
  };

  const deliverOnce = async (payload: ReplyPayload, info: ReplyDispatchRuntimeInfo) => {
    let deliverPayload: ReplyPayload | null = payload;
    let deliveryStarted = false;
    const custody = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;
    const settleCustody = (state: "delivered" | "unknown") =>
      custody
        ? settlePendingFinalDelivery({ kind: "pending-final", ...custody }, state, ["queued"])
        : undefined;
    try {
      if (beforeDeliver) {
        try {
          deliverPayload = await beforeDeliver(payload, info);
        } catch (error) {
          await notifyBeforeDeliverCancelled(payload, info);
          throw error;
        }
        if (!deliverPayload) {
          // Record the intentional non-delivery before observers run so a
          // restart during observer work cannot replay a suppressed final.
          if (custody) {
            await settlePendingFinalDelivery({ kind: "pending-final", ...custody }, "suppressed", [
              "prepared",
            ]);
          }
          await notifyBeforeDeliverCancelled(payload, info);
          return { settlement: Promise.resolve<ReplyDispatchDeliveryOutcome>("cancelled") };
        }
        deliverPayload = copyReplyPayloadMetadata(payload, deliverPayload);
      }
      if (custody) {
        // Claim direct-send custody before provider I/O; a non-prepared marker
        // means another owner already delivered, suppressed, or superseded this
        // final, so repeating the send would duplicate it.
        const claim = await settlePendingFinalDelivery(
          { kind: "pending-final", ...custody },
          "queued",
          ["prepared"],
        );
        if (claim.state !== "queued") {
          await notifyBeforeDeliverCancelled(payload, info);
          return { settlement: Promise.resolve<ReplyDispatchDeliveryOutcome>("cancelled") };
        }
      }
      deliveryStarted = true;
      const result = await options.deliver(deliverPayload, info);
      const finalization =
        isRecord(result) && result.finalization instanceof Promise
          ? result.finalization
          : undefined;
      pendingFinalizations += finalization ? 1 : 0;
      return {
        settlement: (async (): Promise<ReplyDispatchDeliveryOutcome> => {
          try {
            const finalized = finalization ? await finalization : undefined;
            await settleCustody("delivered");
            const outcome =
              finalization && isRecord(result) && isRecord(finalized)
                ? { ...result, ...finalized, finalization: undefined }
                : result;
            return resolveReplyDispatchDeliveryOutcome(outcome);
          } catch {
            await settleCustody("unknown");
            return "failed-deliver";
          } finally {
            pendingFinalizations -= finalization ? 1 : 0;
          }
        })(),
      };
    } catch (error) {
      const retryableNoSend = isRetryableNoSendFailure(error);
      if (retryableNoSend) {
        retryableNoSendError ??= toErrorObject(error, "reply delivery failed before dispatch");
      }
      const outcome: ReplyDispatchDeliveryOutcome =
        deliveryStarted && !retryableNoSend ? "failed-deliver" : "failed-before-deliver";
      if (custody && deliveryStarted) {
        // Proven no-send keeps the marker replayable for restart recovery —
        // including after direct custody escalated queued→unknown pre-I/O,
        // since the error proves the send never crossed the wire. Anything
        // else after platform I/O started fails closed as "unknown".
        await settlePendingFinalDelivery(
          { kind: "pending-final", ...custody },
          outcome === "failed-deliver" ? "unknown" : "prepared",
          outcome === "failed-deliver" ? ["queued"] : ["queued", "unknown"],
        );
      }
      try {
        await options.onError?.(error, info);
      } catch {}
      return { settlement: Promise.resolve(outcome) };
    }
  };

  const startSerializedDelivery = (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
    shouldDelay: boolean,
  ) =>
    scheduleDelivery(async () => {
      if (shouldDelay) {
        const delayMs = getHumanDelay(options.humanDelay);
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
      return await deliverOnce(payload, info);
    });

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const fallback = undeliveredFallbacks.get(payload);
    undeliveredFallbacks.delete(payload);
    const originalWasExactSilent = isSilentReplyText(payload.text, SILENT_REPLY_TOKEN);
    const normalizedPrimary =
      getReplyPayloadMetadata(payload)?.replyDispatcherNormalizationOwner === dispatcher
        ? ({ kind: "deliver", payload } as const)
        : normalizeForDispatch(kind, payload, true);
    const normalizedFallback =
      fallback &&
      !(normalizedPrimary.kind === "suppress" && normalizedPrimary.reason === "channel_transform")
        ? normalizeForDispatch(kind, fallback, false)
        : undefined;
    const normalized =
      normalizedPrimary.kind === "deliver"
        ? normalizedPrimary.payload
        : normalizedFallback?.kind === "deliver"
          ? normalizedFallback.payload
          : null;
    if (!normalized) {
      if (kind === "final" && originalWasExactSilent) {
        silentReplyLogger.debug("exact NO_REPLY final payload was skipped before delivery", {
          hasSessionKey: Boolean(options.silentReplyContext?.sessionKey),
          surface: options.silentReplyContext?.surface,
          conversationType: options.silentReplyContext?.conversationType,
        });
      }
      return false;
    }
    const deliveryFallback =
      normalizedPrimary.kind === "deliver" && normalizedFallback?.kind === "deliver"
        ? normalizedFallback.payload
        : null;
    queuedCounts[kind] += 1;
    pending += 1;
    const deliveryOutcomeTracker = deliveryOutcomeTrackers.get(payload);
    if (deliveryOutcomeTracker) {
      deliveryOutcomeTracker.tracked = true;
    }

    // Determine if we should add human-like delay (only for block replies after the first).
    const shouldDelay = kind === "block" && sentFirstBlock;
    if (kind === "block") {
      sentFirstBlock = true;
    }
    let deliveryOutcome: ReplyDispatchDeliveryOutcome = "failed-before-deliver";
    const dispatchInfo = buildReplyDispatchRuntimeInfo(normalized, kind);
    const delivery = startSerializedDelivery(normalized, dispatchInfo, shouldDelay);
    void enqueueSettlement(async () => {
      try {
        const attempt = await delivery;
        deliveryOutcome = await attempt.settlement;
        if (deliveryFallback && shouldRetryReplyDispatch(deliveryOutcome)) {
          const fallbackAttempt = await startSerializedDelivery(
            deliveryFallback,
            dispatchInfo,
            false,
          );
          deliveryOutcome = await fallbackAttempt.settlement;
        }
        settledCounts[kind][REPLY_DISPATCH_OUTCOME_COUNTS[deliveryOutcome]] += 1;
      } catch (err: unknown) {
        settledCounts[kind].failedBeforeSend += 1;
        try {
          await options.onError?.(err, dispatchInfo);
        } catch {}
        deliveryOutcome = "failed-before-deliver";
      } finally {
        deliveryOutcomeTracker?.resolve(deliveryOutcome);
        deliveryOutcomeTrackers.delete(payload);
        try {
          options.onDeliverySettled?.(dispatchInfo);
        } catch (err: unknown) {
          reportObserverError(err, dispatchInfo);
        }
        pending -= 1;
        if (pending === 1 && completeCalled) {
          pending -= 1;
        }
        if (pending === 0) {
          unregister();
          notifyIdle();
        }
      }
    });
    return true;
  };

  const markComplete = () => {
    if (completeCalled) {
      return;
    }
    completeCalled = true;
    // If no replies were enqueued (pending is still 1 = just the reservation),
    // schedule clearing the reservation after current microtasks complete.
    // This gives any in-flight enqueue() calls a chance to increment pending.
    void Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        // Still just the reservation, no replies were enqueued
        pending -= 1;
        if (pending === 0) {
          unregister();
          notifyIdle();
        }
      }
    });
  };

  const dispatcher: ReplyDispatcher = {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    appendBeforeDeliver: (hook, stageOptions) => {
      beforeDeliver = composeReplyDispatchBeforeDeliver(beforeDeliver, {
        hook,
        options: stageOptions,
      });
    },
    supportsSettledReceipt: true,
    waitForIdle: async () => {
      await waitForIdle();
      const receipt = buildReceipt();
      if (
        options.propagateRetryableNoSendFailure === true &&
        !receipt.anyVisibleDelivered &&
        retryableNoSendError !== undefined
      ) {
        throw retryableNoSendError;
      }
      return receipt;
    },
    getQueuedCounts: () => ({ ...queuedCounts }),
    getCancelledCounts: () => mapReplyDispatchCounts(settledCounts, (counts) => counts.cancelled),
    getFailedCounts: () =>
      mapReplyDispatchCounts(
        settledCounts,
        (counts) => counts.failedBeforeSend + counts.failedAfterSend,
      ),
    markComplete,
    resolveFollowupAdmissionBarrierTimeoutPolicy:
      options.resolveFollowupAdmissionBarrierTimeoutPolicy
        ? () =>
            options.resolveFollowupAdmissionBarrierTimeoutPolicy?.({
              queuedCounts: { ...queuedCounts },
              humanDelayBudgetMs:
                Math.max(0, queuedCounts.block - 1) * getHumanDelayMax(options.humanDelay),
            })
        : undefined,
  };
  replyDispatcherPreparers.set(dispatcher, {
    owner: dispatcher,
    normalize: (kind, payload) => normalizeForDispatch(kind, payload, true),
  });
  return dispatcher;
}

export async function waitForReplyDispatcherIdle(
  dispatcher: Pick<ReplyDispatcher, "waitForIdle">,
  abortSignal?: AbortSignal,
): Promise<ReplyDispatchReceipt | undefined> {
  if (!abortSignal) {
    return (await dispatcher.waitForIdle()) || undefined;
  }
  if (abortSignal.aborted) {
    return undefined;
  }
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    const onAbort = () => resolve(undefined);
    abortSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
  });
  try {
    return (await Promise.race([dispatcher.waitForIdle(), aborted])) || undefined;
  } finally {
    removeAbortListener?.();
  }
}

export function createReplyDispatcherWithTyping(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherWithTypingResult {
  const {
    typingCallbacks,
    onReplyStart,
    onIdle,
    onSettled,
    onFreshSettledDelivery: _onFreshSettledDelivery,
    onCleanup,
    ...dispatcherOptions
  } = options;
  const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
  const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
  const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
  let typingController: TypingController | undefined;
  const dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: async () => {
      typingController?.markDispatchIdle();
      const idle = resolvedOnIdle?.();
      if (idle) {
        await Promise.resolve(idle);
      }
      await onSettled?.();
    },
  });

  return {
    dispatcher,
    replyOptions: {
      onReplyStart: resolvedOnReplyStart,
      onTypingCleanup: resolvedOnCleanup,
      onTypingController: (typing) => {
        typingController = typing;
      },
    },
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
    markRunComplete: () => {
      typingController?.markRunComplete();
    },
  };
}
