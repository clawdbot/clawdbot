// Dispatches final reply payloads through visible senders and message tools.
import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateSecureInt } from "../../infra/secure-random.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { sleep } from "../../utils.js";
import { copyReplyPayloadMetadata, getReplyPayloadMetadata } from "../reply-payload.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import { normalizeReplyPayload, type NormalizeReplySkipReason } from "./normalize-reply.js";
import type {
  ReplyDispatchBeforeDeliver,
  ReplyDispatchBeforeDeliverOptions,
  ReplyDispatchKind,
  ReplyDispatchRuntimeInfo,
  ReplyDispatcher,
  ReplyFollowupAdmissionBarrierTimeoutPolicy,
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

export type ReplyDispatchDeliveryOutcome =
  | "delivered"
  | "cancelled"
  | "failed-before-deliver"
  | "failed-deliver";

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

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;
const DEFAULT_BEFORE_DELIVER_TIMEOUT_MS = 15_000;
const silentReplyLogger = createSubsystemLogger("silent-reply/dispatcher");
const beforeDeliverCancelledHooks = new WeakMap<ReplyDispatcher, ReplyDispatchCancelHandler[]>();
const deliveryOutcomeTrackers = new WeakMap<ReplyPayload, ReplyDispatchDeliveryOutcomeTracker>();

type ReplyDispatchBeforeDeliverStage = {
  hook: ReplyDispatchBeforeDeliver;
  timeoutMs?: number;
};

type ReplyDispatchBeforeDeliverStageInput =
  | ReplyDispatchBeforeDeliver
  | {
      hook: ReplyDispatchBeforeDeliver;
      options?: ReplyDispatchBeforeDeliverOptions;
    }
  | undefined;

const beforeDeliverStagesByHook = new WeakMap<
  ReplyDispatchBeforeDeliver,
  readonly ReplyDispatchBeforeDeliverStage[]
>();

class ReplyDispatchBeforeDeliverTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`beforeDeliver timed out after ${timeoutMs}ms`);
    this.name = "ReplyDispatchBeforeDeliverTimeoutError";
  }
}

function resolveReplyDispatchBeforeDeliverTimeoutMs(
  options: ReplyDispatchBeforeDeliverOptions | undefined,
): number {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_BEFORE_DELIVER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("beforeDeliver timeoutMs must be a positive finite number");
  }
  return timeoutMs;
}

async function runReplyDispatchBeforeDeliverStage(
  stage: ReplyDispatchBeforeDeliverStage,
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
): Promise<ReplyPayload | null> {
  const timeoutMs = stage.timeoutMs;
  if (!timeoutMs) {
    return await stage.hook(payload, info);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The hook promise cannot be cancelled. The deadline releases the serialized
  // delivery owner; Promise.race still observes any late rejection.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ReplyDispatchBeforeDeliverTimeoutError(timeoutMs)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(stage.hook(payload, info)), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function resolveReplyDispatchBeforeDeliverStages(
  input: ReplyDispatchBeforeDeliverStageInput,
): readonly ReplyDispatchBeforeDeliverStage[] {
  if (!input) {
    return [];
  }
  if (typeof input === "function") {
    return (
      beforeDeliverStagesByHook.get(input) ?? [
        { hook: input, timeoutMs: DEFAULT_BEFORE_DELIVER_TIMEOUT_MS },
      ]
    );
  }
  const existingStages = beforeDeliverStagesByHook.get(input.hook);
  // Internal composition already assigned each real stage its owner budget.
  // Wrapping that chain again would turn one stage budget into an aggregate deadline.
  if (existingStages) {
    return existingStages;
  }
  return [
    {
      hook: input.hook,
      timeoutMs: resolveReplyDispatchBeforeDeliverTimeoutMs(input.options),
    },
  ];
}

/** Compose core delivery stages while retaining a separate deadline for each actual hook. */
export function composeReplyDispatchBeforeDeliver(
  ...hooks: ReplyDispatchBeforeDeliverStageInput[]
): ReplyDispatchBeforeDeliver | undefined {
  const stages: ReplyDispatchBeforeDeliverStage[] = [];
  for (const hook of hooks) {
    if (hook) {
      stages.push(...resolveReplyDispatchBeforeDeliverStages(hook));
    }
  }
  if (stages.length === 0) {
    return undefined;
  }
  const composed: ReplyDispatchBeforeDeliver = async (payload, info) => {
    let current: ReplyPayload | null = payload;
    for (const stage of stages) {
      if (!current) {
        return null;
      }
      const next = await runReplyDispatchBeforeDeliverStage(stage, current, info);
      current = next ? copyReplyPayloadMetadata(current, next) : null;
    }
    return current;
  };
  beforeDeliverStagesByHook.set(composed, stages);
  return composed;
}

/** Mark a core hook whose lifecycle owner controls settlement and any deadline. */
export function markReplyDispatchBeforeDeliverDeadlineOwned(
  hook: ReplyDispatchBeforeDeliver,
): ReplyDispatchBeforeDeliver {
  beforeDeliverStagesByHook.set(hook, [{ hook }]);
  return hook;
}

/** Adds a core-internal cancellation observer without expanding the plugin-facing dispatcher. */
export function appendReplyDispatcherBeforeDeliverCancelled(
  dispatcher: ReplyDispatcher,
  hook: ReplyDispatchCancelHandler,
): boolean {
  const hooks = beforeDeliverCancelledHooks.get(dispatcher);
  if (!hooks) {
    return false;
  }
  hooks.push(hook);
  return true;
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

function buildReplyDispatchRuntimeInfo(
  payload: ReplyPayload,
  kind: ReplyDispatchKind,
): ReplyDispatchRuntimeInfo {
  const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
  return {
    kind,
    ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
  };
}

/** Generate a random delay within the configured range. */
function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") {
    return 0;
  }
  const min =
    mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
  if (max <= min) {
    return min;
  }
  return min + generateSecureInt(max - min + 1);
}

function getHumanDelayMax(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") {
    return 0;
  }
  const min =
    mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
  return max <= min ? min : max;
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
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

function normalizeReplyPayloadInternal(
  payload: ReplyPayload,
  opts: NormalizeReplyPayloadInternalOptions,
): ReplyPayload | null {
  // Prefer dynamic context provider over static context
  const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;

  return normalizeReplyPayload(payload, {
    responsePrefix: opts.responsePrefix,
    responsePrefixContext: prefixContext,
    onHeartbeatStrip: opts.onHeartbeatStrip,
    transformReplyPayload: opts.transformReplyPayload,
    onSkip: opts.onSkip,
  });
}

export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  let beforeDeliver = composeReplyDispatchBeforeDeliver(
    options.beforeDeliver
      ? { hook: options.beforeDeliver, options: options.beforeDeliverOptions }
      : undefined,
  );
  const appendedBeforeDeliverCancelledHooks: ReplyDispatchCancelHandler[] = [];
  let sendChain: Promise<void> = Promise.resolve();
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
  const failedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const cancelledCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };

  // Register this dispatcher globally for gateway restart coordination.
  const { unregister } = registerDispatcher({
    pending: () => pending,
    waitForIdle: () => sendChain,
  });

  const reportObserverError = (err: unknown, info: ReplyDispatchRuntimeInfo) => {
    void Promise.resolve(options.onError?.(err, info)).catch(() => undefined);
  };

  const notifyBeforeDeliverCancelled = async (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ) => {
    const observers = [
      ...(options.onBeforeDeliverCancelled ? [options.onBeforeDeliverCancelled] : []),
      ...appendedBeforeDeliverCancelledHooks,
    ];
    for (const observer of observers) {
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
    }
  };

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const originalWasExactSilent = isSilentReplyText(payload.text, SILENT_REPLY_TOKEN);
    const normalized = normalizeReplyPayloadInternal(payload, {
      responsePrefix: options.responsePrefix,
      responsePrefixContext: options.responsePrefixContext,
      responsePrefixContextProvider: options.responsePrefixContextProvider,
      transformReplyPayload: options.transformReplyPayload,
      onHeartbeatStrip: options.onHeartbeatStrip,
      onSkip: (reason) =>
        options.onSkip?.(payload, {
          ...buildReplyDispatchRuntimeInfo(payload, kind),
          reason,
        }),
    });
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
    let deliveryStarted = false;
    let deliveryOutcome: ReplyDispatchDeliveryOutcome = "failed-before-deliver";

    sendChain = sendChain
      .then(async () => {
        // Add human-like delay between block replies for natural rhythm.
        if (shouldDelay) {
          const delayMs = getHumanDelay(options.humanDelay);
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }
        const dispatchInfo = buildReplyDispatchRuntimeInfo(normalized, kind);
        let deliverPayload: ReplyPayload | null = normalized;
        if (beforeDeliver) {
          try {
            deliverPayload = await beforeDeliver(normalized, dispatchInfo);
          } catch (err: unknown) {
            await notifyBeforeDeliverCancelled(normalized, dispatchInfo);
            throw err;
          }
          if (!deliverPayload) {
            deliveryOutcome = "cancelled";
            cancelledCounts[kind] += 1;
            await notifyBeforeDeliverCancelled(normalized, dispatchInfo);
            return;
          }
          deliverPayload = copyReplyPayloadMetadata(normalized, deliverPayload);
        }
        deliveryStarted = true;
        await options.deliver(deliverPayload, dispatchInfo);
        deliveryOutcome = "delivered";
      })
      .catch(async (err: unknown) => {
        deliveryOutcome = deliveryStarted ? "failed-deliver" : "failed-before-deliver";
        failedCounts[kind] += 1;
        // Error cleanup belongs to this send: idle/finalization must not race it.
        // Observer failures stay isolated from later queued deliveries.
        try {
          await options.onError?.(err, buildReplyDispatchRuntimeInfo(normalized, kind));
        } catch {}
      })
      .finally(() => {
        const dispatchInfo = buildReplyDispatchRuntimeInfo(normalized, kind);
        deliveryOutcomeTracker?.resolve(deliveryOutcome);
        deliveryOutcomeTrackers.delete(payload);
        try {
          options.onDeliverySettled?.(dispatchInfo);
        } catch (err: unknown) {
          reportObserverError(err, dispatchInfo);
        }
        pending -= 1;
        // Clear reservation if:
        // 1. pending is now 1 (just the reservation left)
        // 2. markComplete has been called
        // 3. No more replies will be enqueued
        if (pending === 1 && completeCalled) {
          pending -= 1; // Clear the reservation
        }
        if (pending === 0) {
          // Unregister from global tracking when idle.
          unregister();
          void options.onIdle?.();
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
          void options.onIdle?.();
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
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    getCancelledCounts: () => ({ ...cancelledCounts }),
    getFailedCounts: () => ({ ...failedCounts }),
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
  beforeDeliverCancelledHooks.set(dispatcher, appendedBeforeDeliverCancelledHooks);
  return dispatcher;
}

export async function waitForReplyDispatcherIdle(
  dispatcher: Pick<ReplyDispatcher, "waitForIdle">,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!abortSignal) {
    await dispatcher.waitForIdle();
    return;
  }
  if (abortSignal.aborted) {
    return;
  }
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    abortSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([dispatcher.waitForIdle(), aborted]);
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
    onSettled: _onSettled,
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
    onIdle: () => {
      typingController?.markDispatchIdle();
      return resolvedOnIdle?.();
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
