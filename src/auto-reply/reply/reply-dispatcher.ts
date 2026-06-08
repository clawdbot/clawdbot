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
  ReplyDispatchKind,
  ReplyDispatchRuntimeInfo,
  ReplyDispatcher,
} from "./reply-dispatcher.types.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import type { TypingController } from "./typing.js";

export type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

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

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
) => Promise<unknown>;

export type { ReplyDispatchBeforeDeliver };

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;
const silentReplyLogger = createSubsystemLogger("silent-reply/dispatcher");

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
  onBeforeDeliverCancelled?: ReplyDispatchCancelHandler;
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
  let beforeDeliver = options.beforeDeliver;
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

    // Determine if we should add human-like delay (only for block replies after the first).
    const shouldDelay = kind === "block" && sentFirstBlock;
    if (kind === "block") {
      sentFirstBlock = true;
    }

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
            try {
              await options.onBeforeDeliverCancelled?.(normalized, dispatchInfo);
            } catch (cancelErr: unknown) {
              void options.onError?.(cancelErr, dispatchInfo);
            }
            throw err;
          }
          if (!deliverPayload) {
            cancelledCounts[kind] += 1;
            try {
              await options.onBeforeDeliverCancelled?.(normalized, dispatchInfo);
            } catch (err: unknown) {
              void options.onError?.(err, dispatchInfo);
            }
            return;
          }
          deliverPayload = copyReplyPayloadMetadata(normalized, deliverPayload);
        }
        await options.deliver(deliverPayload, dispatchInfo);
      })
      .catch((err: unknown) => {
        failedCounts[kind] += 1;
        void options.onError?.(err, buildReplyDispatchRuntimeInfo(normalized, kind));
      })
      .finally(() => {
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

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    appendBeforeDeliver: (hook) => {
      const previousBeforeDeliver = beforeDeliver;
      beforeDeliver = previousBeforeDeliver
        ? async (payload, info) => {
            const previousPayload = await previousBeforeDeliver(payload, info);
            return previousPayload
              ? hook(copyReplyPayloadMetadata(payload, previousPayload), info)
              : null;
          }
        : hook;
    },
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    getCancelledCounts: () => ({ ...cancelledCounts }),
    getFailedCounts: () => ({ ...failedCounts }),
    markComplete,
  };
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
