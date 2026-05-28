import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  deriveInboundMessageHookContext,
  toPluginMessageContext,
} from "../hooks/message-hook-mappers.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../infra/diagnostics-timeline.js";
import { isOutboundDeliveryError } from "../infra/outbound/deliver-types.js";
import { logMessageReceived } from "../logging/diagnostic.js";
import { hasOutboundReplyContent } from "../plugin-sdk/reply-payload.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { SilentReplyConversationType } from "../shared/silent-reply-policy.js";
import {
  resolveCommandTurnContext,
  resolveCommandTurnTargetSessionKey,
} from "./command-turn-context.js";
import { withReplyDispatcher } from "./dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.types.js";
import type { GetReplyFromConfig } from "./reply/get-reply.types.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatchBeforeDeliver,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions, ReplyPayload } from "./types.js";

type ForegroundReplyFenceState = {
  generation: number;
  visibleDeliveryGeneration: number;
  activeDispatches: number;
  activeGenerations: Map<number, number>;
  waiters: Set<() => void>;
};

type ForegroundReplyFenceSnapshot = {
  key: string;
  generation: number;
};

const foregroundReplyFenceByKey = new Map<string, ForegroundReplyFenceState>();

function normalizeForegroundReplyFencePart(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveForegroundReplyFenceKey(finalized: FinalizedMsgContext): string | undefined {
  const sessionKey = normalizeForegroundReplyFencePart(finalized.SessionKey);
  const channel =
    normalizeForegroundReplyFencePart(finalized.OriginatingChannel) ??
    normalizeForegroundReplyFencePart(finalized.Surface) ??
    normalizeForegroundReplyFencePart(finalized.Provider);
  const target =
    normalizeForegroundReplyFencePart(finalized.OriginatingTo) ??
    normalizeForegroundReplyFencePart(finalized.NativeChannelId) ??
    normalizeForegroundReplyFencePart(finalized.From) ??
    normalizeForegroundReplyFencePart(finalized.To);

  if (!sessionKey || !channel || !target) {
    return undefined;
  }

  return JSON.stringify([
    "foreground",
    channel,
    normalizeForegroundReplyFencePart(finalized.AccountId) ?? "default",
    sessionKey,
    normalizeChatType(finalized.ChatType) ?? "unknown",
    target,
  ]);
}

function beginForegroundReplyFence(
  finalized: FinalizedMsgContext,
): ForegroundReplyFenceSnapshot | undefined {
  const key = resolveForegroundReplyFenceKey(finalized);
  if (!key) {
    return undefined;
  }
  const state = foregroundReplyFenceByKey.get(key) ?? {
    generation: 0,
    visibleDeliveryGeneration: 0,
    activeDispatches: 0,
    activeGenerations: new Map<number, number>(),
    waiters: new Set<() => void>(),
  };
  state.generation += 1;
  state.activeDispatches += 1;
  state.activeGenerations.set(
    state.generation,
    (state.activeGenerations.get(state.generation) ?? 0) + 1,
  );
  foregroundReplyFenceByKey.set(key, state);
  return {
    key,
    generation: state.generation,
  };
}

function notifyForegroundReplyFenceWaiters(state: ForegroundReplyFenceState): void {
  const waiters = [...state.waiters];
  state.waiters.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

function hasNewerActiveForegroundReplyFenceGeneration(
  state: ForegroundReplyFenceState,
  generation: number,
): boolean {
  for (const [activeGeneration, count] of state.activeGenerations) {
    if (activeGeneration > generation && count > 0) {
      return true;
    }
  }
  return false;
}

async function shouldCancelForegroundReplyDelivery(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
): Promise<boolean> {
  if (!snapshot) {
    return false;
  }
  while (true) {
    const state = foregroundReplyFenceByKey.get(snapshot.key);
    if (!state) {
      return false;
    }
    if (state.visibleDeliveryGeneration > snapshot.generation) {
      return true;
    }
    if (!hasNewerActiveForegroundReplyFenceGeneration(state, snapshot.generation)) {
      return false;
    }
    await new Promise<void>((resolve) => {
      state.waiters.add(resolve);
    });
  }
}

function markForegroundReplyFenceVisibleDelivery(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
  payload: ReplyPayload,
  deliveryResult: unknown,
): void {
  if (!snapshot || !hasOutboundReplyContent(payload, { trimText: true })) {
    return;
  }
  if (isExplicitlyNonVisibleDelivery(deliveryResult)) {
    return;
  }
  markForegroundReplyFenceVisibleDeliveryGeneration(snapshot);
}

function markForegroundReplyFenceVisibleDeliveryGeneration(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
): void {
  if (!snapshot) {
    return;
  }
  const state = foregroundReplyFenceByKey.get(snapshot.key);
  if (!state) {
    return;
  }
  state.visibleDeliveryGeneration = Math.max(state.visibleDeliveryGeneration, snapshot.generation);
  notifyForegroundReplyFenceWaiters(state);
}

function isExplicitlyNonVisibleDelivery(deliveryResult: unknown): boolean {
  return (
    typeof deliveryResult === "object" &&
    deliveryResult !== null &&
    !Array.isArray(deliveryResult) &&
    "visibleReplySent" in deliveryResult &&
    (deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

function isExplicitlyVisibleDelivery(deliveryResult: unknown): boolean {
  return (
    typeof deliveryResult === "object" &&
    deliveryResult !== null &&
    !Array.isArray(deliveryResult) &&
    (deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === true
  );
}

function isVisiblePartialDeliveryError(error: unknown): boolean {
  if (isOutboundDeliveryError(error)) {
    return error.sentBeforeError;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    ((error as { visibleReplySent?: unknown }).visibleReplySent === true ||
      (error as { sentBeforeError?: unknown }).sentBeforeError === true)
  );
}

async function runForegroundReplyFenceFreshSettledDelivery(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
  onFreshSettledDelivery: (() => unknown) | undefined,
): Promise<void> {
  if (!onFreshSettledDelivery) {
    return;
  }
  if (await shouldCancelForegroundReplyDelivery(snapshot)) {
    return;
  }
  try {
    const deliveryResult = await onFreshSettledDelivery();
    if (isExplicitlyVisibleDelivery(deliveryResult)) {
      markForegroundReplyFenceVisibleDeliveryGeneration(snapshot);
    }
  } catch (err: unknown) {
    if (isVisiblePartialDeliveryError(err)) {
      markForegroundReplyFenceVisibleDeliveryGeneration(snapshot);
    }
    throw err;
  }
}

function endForegroundReplyFence(snapshot: ForegroundReplyFenceSnapshot): void {
  const state = foregroundReplyFenceByKey.get(snapshot.key);
  if (!state) {
    return;
  }
  const activeGenerationCount = state.activeGenerations.get(snapshot.generation) ?? 0;
  if (activeGenerationCount <= 1) {
    state.activeGenerations.delete(snapshot.generation);
  } else {
    state.activeGenerations.set(snapshot.generation, activeGenerationCount - 1);
  }
  state.activeDispatches -= 1;
  notifyForegroundReplyFenceWaiters(state);
  if (state.activeDispatches <= 0) {
    foregroundReplyFenceByKey.delete(snapshot.key);
  }
}

function resolveDispatcherSilentReplyContext(
  ctx: MsgContext | FinalizedMsgContext,
  cfg: OpenClawConfig,
) {
  const finalized = finalizeInboundContext(ctx);
  const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(finalized);
  const policySessionKey = commandTargetSessionKey ?? finalized.SessionKey;
  const chatType = normalizeChatType(finalized.ChatType);
  const conversationType: SilentReplyConversationType | undefined =
    commandTargetSessionKey && commandTargetSessionKey !== finalized.SessionKey
      ? undefined
      : chatType === "direct"
        ? "direct"
        : chatType === "group" || chatType === "channel"
          ? "group"
          : undefined;
  return {
    cfg,
    sessionKey: policySessionKey,
    surface: finalized.Surface ?? finalized.Provider,
    conversationType,
  };
}

function resolveInboundReplyHookTarget(
  finalized: FinalizedMsgContext,
  hookCtx: ReturnType<typeof deriveInboundMessageHookContext>,
): string {
  if (typeof finalized.OriginatingTo === "string" && finalized.OriginatingTo.trim()) {
    return finalized.OriginatingTo;
  }
  if (hookCtx.isGroup) {
    return hookCtx.conversationId ?? hookCtx.to ?? hookCtx.from;
  }
  return hookCtx.from || hookCtx.conversationId || hookCtx.to || "";
}

function buildMessageSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
): ReplyDispatchBeforeDeliver | undefined {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return undefined;
  }

  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);

  return async (payload: ReplyPayload): Promise<ReplyPayload | null> => {
    if (!payload.text) {
      return payload;
    }

    const result = await hookRunner.runMessageSending(
      { content: payload.text, to: replyTarget },
      toPluginMessageContext(hookCtx),
    );

    if (result?.cancel) {
      return null;
    }
    if (result?.content != null) {
      return { ...payload, text: result.content };
    }
    return payload;
  };
}

function buildDispatchTimelineAttributes(ctx: MsgContext | FinalizedMsgContext) {
  const commandTurn = resolveCommandTurnContext(ctx);
  return {
    surface:
      typeof ctx.Surface === "string"
        ? ctx.Surface
        : typeof ctx.Provider === "string"
          ? ctx.Provider
          : "unknown",
    hasSessionKey:
      typeof ctx.SessionKey === "string" || typeof ctx.CommandTargetSessionKey === "string",
    commandSource: commandTurn.source,
  };
}

export type DispatchInboundResult = DispatchFromConfigResult;
export { settleReplyDispatcher, withReplyDispatcher } from "./dispatch-dispatcher.js";

function finalizeDispatchResult(
  result: DispatchFromConfigResult,
  dispatcher: ReplyDispatcher,
): DispatchFromConfigResult {
  const cancelledCounts = dispatcher.getCancelledCounts?.();
  const failedCounts = dispatcher.getFailedCounts?.();
  if (!cancelledCounts && !failedCounts) {
    return result;
  }

  const resultCounts = {
    tool: result.counts?.tool ?? 0,
    block: result.counts?.block ?? 0,
    final: result.counts?.final ?? 0,
  };
  const counts = {
    tool: Math.max(0, resultCounts.tool - (cancelledCounts?.tool ?? 0) - (failedCounts?.tool ?? 0)),
    block: Math.max(
      0,
      resultCounts.block - (cancelledCounts?.block ?? 0) - (failedCounts?.block ?? 0),
    ),
    final: Math.max(
      0,
      resultCounts.final - (cancelledCounts?.final ?? 0) - (failedCounts?.final ?? 0),
    ),
  };
  const hasFailedCounts =
    (failedCounts?.tool ?? 0) > 0 ||
    (failedCounts?.block ?? 0) > 0 ||
    (failedCounts?.final ?? 0) > 0;
  return {
    ...result,
    queuedFinal: result.queuedFinal && counts.final > 0,
    counts,
    ...(hasFailedCounts ? { failedCounts } : {}),
  };
}

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = measureDiagnosticsTimelineSpanSync(
    "auto_reply.finalize_context",
    () => finalizeInboundContext(params.ctx),
    {
      phase: "agent-turn",
      config: params.cfg,
      attributes: buildDispatchTimelineAttributes(params.ctx),
    },
  );
  if (isDiagnosticsEnabled(params.cfg)) {
    logMessageReceived({
      sessionKey: finalized.SessionKey,
      channel: finalized.Surface ?? finalized.Provider,
      chatId: finalized.To ?? finalized.From,
      messageId: finalized.MessageSid ?? finalized.MessageSidFirst ?? finalized.MessageSidLast,
      source: "dispatchInboundMessage",
    });
  }
  const result = await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () =>
      measureDiagnosticsTimelineSpan(
        "auto_reply.dispatch_reply_from_config",
        () =>
          dispatchReplyFromConfig({
            ctx: finalized,
            cfg: params.cfg,
            dispatcher: params.dispatcher,
            replyOptions: params.replyOptions,
            replyResolver: params.replyResolver,
          }),
        {
          phase: "agent-turn",
          config: params.cfg,
          attributes: buildDispatchTimelineAttributes(finalized),
        },
      ),
  });
  return finalizeDispatchResult(result, params.dispatcher);
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  const foregroundReplyFence = beginForegroundReplyFence(finalized);
  const silentReplyContext = resolveDispatcherSilentReplyContext(finalized, params.cfg);
  const configuredBeforeDeliver =
    params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(finalized);
  const beforeDeliver: ReplyDispatchBeforeDeliver | undefined =
    foregroundReplyFence || configuredBeforeDeliver
      ? async (payload, info) => {
          if (await shouldCancelForegroundReplyDelivery(foregroundReplyFence)) {
            return null;
          }
          const deliverPayload = configuredBeforeDeliver
            ? await configuredBeforeDeliver(payload, info)
            : payload;
          if (
            !deliverPayload ||
            (await shouldCancelForegroundReplyDelivery(foregroundReplyFence))
          ) {
            return null;
          }
          return deliverPayload;
        }
      : undefined;
  const deliver: ReplyDispatcherWithTypingOptions["deliver"] = async (payload, info) => {
    try {
      const result = await params.dispatcherOptions.deliver(payload, info);
      markForegroundReplyFenceVisibleDelivery(foregroundReplyFence, payload, result);
      return result;
    } catch (err: unknown) {
      if (isVisiblePartialDeliveryError(err)) {
        markForegroundReplyFenceVisibleDelivery(foregroundReplyFence, payload, {
          visibleReplySent: true,
        });
      }
      throw err;
    }
  };
  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...params.dispatcherOptions,
      deliver,
      beforeDeliver,
      silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext,
    });
  try {
    return await dispatchInboundMessage({
      ctx: finalized,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    try {
      const settledResult = await params.dispatcherOptions.onSettled?.();
      if (isExplicitlyVisibleDelivery(settledResult)) {
        markForegroundReplyFenceVisibleDeliveryGeneration(foregroundReplyFence);
      }
      await runForegroundReplyFenceFreshSettledDelivery(
        foregroundReplyFence,
        params.dispatcherOptions.onFreshSettledDelivery,
      );
    } finally {
      if (foregroundReplyFence) {
        endForegroundReplyFence(foregroundReplyFence);
      }
      markRunComplete();
      markDispatchIdle();
    }
  }
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const silentReplyContext = resolveDispatcherSilentReplyContext(params.ctx, params.cfg);
  const dispatcher = createReplyDispatcher({
    ...params.dispatcherOptions,
    beforeDeliver:
      params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(params.ctx),
    silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext,
  });
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
