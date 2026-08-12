import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../../auto-reply/dispatch.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { suppressPendingFinalDelivery } from "../../auto-reply/reply/dispatch-from-config.pending-final.js";
import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { runWithSessionInitConflictRetry } from "../../auto-reply/reply/session-init-conflict-retry.js";
import { withReplySystemEventSessionKey } from "../../auto-reply/reply/system-event-session-key.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
} from "../../hooks/message-hook-mappers.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { applyMessageSendingHook } from "../../infra/outbound/deliver-hooks.js";
import { normalizeEmptyPayloadForDelivery } from "../../infra/outbound/deliver-payload.js";
import {
  isPlatformMessageNotDispatchedError,
  isPlatformMessageRejectedError,
} from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { createMessageSentEmitter } from "../../infra/outbound/message-sent-hook.js";
import { summarizeOutboundPayloadForTransport } from "../../infra/outbound/payloads.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { copyChannelParticipantAdmissionEvidence } from "../message-access/admission-evidence.js";
import { resolveMessageReceiptPrimaryId } from "../message/receipt.js";
import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import { recordInboundSession } from "../session.js";
import {
  createSuppressedChannelDeliveryResult,
  isChannelPartialDeliveryError,
} from "./delivery-result.js";
import {
  createDirectPendingFinalCustody,
  NO_PENDING_FINAL_CUSTODY,
  resolvePendingFinalCompletion,
  toCoreManagedDeliveryInfo,
} from "./direct-delivery-custody.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
import { runPreparedChannelTurnCore } from "./execution.js";
import type {
  AssembledChannelTurn,
  ChannelEventDeliveryAdapter,
  ChannelDeliveryInfo,
  ChannelDeliveryOutcome,
  ChannelDeliveryResult,
  ChannelTurnDeliveryAdapter,
  ChannelTurnPlan,
  ChannelProviderOwnedMessageSendingDeliveryAdapter,
  ChannelTurnResolved,
  ChannelTurnResult,
  PreparedChannelTurn,
} from "./types.js";

type RoutedAssembledChannelTurn = Omit<
  AssembledChannelTurn,
  "delivery" | "dispatchReplyWithBufferedBlockDispatcher"
> & {
  delivery: ChannelTurnDeliveryAdapter;
};

type DispatchableChannelTurn = AssembledChannelTurn | RoutedAssembledChannelTurn;
type AnyChannelDeliveryAdapter = ChannelEventDeliveryAdapter | ChannelTurnDeliveryAdapter;

function applyRouteDmScope<T extends AssembledChannelTurn["ctxPayload"]>(
  context: T,
  dmScope: string | undefined,
): T {
  if (!dmScope || context.DmScope === dmScope) {
    return context;
  }
  const scoped = { ...context, DmScope: dmScope } as T;
  // Finalized contexts carry identity evidence out-of-band; keep it attached
  // when routing must replace the object to add the authoritative DM scope.
  copyChannelParticipantAdmissionEvidence(context, scoped);
  return scoped;
}

type PendingChannelDeliveryAttempt = {
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
  result?: ChannelDeliveryResult | void;
  error?: unknown;
};

function resolvePartialChannelDeliveryResult(
  error: unknown,
): (ChannelDeliveryOutcome & { visibleReplySent: true }) | undefined {
  return isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
}

export function assembleResolvedChannelTurn<
  TDispatchResult,
  TDelivery extends ChannelTurnDeliveryAdapter,
>(
  value: ChannelTurnResolved<TDispatchResult, TDelivery>,
): AssembledChannelTurn | RoutedAssembledChannelTurn | PreparedChannelTurn<TDispatchResult> {
  if (!("route" in value)) {
    return value;
  }
  if ("runDispatch" in value) {
    const { cfg, route, ...turn } = value;
    return {
      ...turn,
      ctxPayload: applyRouteDmScope(turn.ctxPayload, route.dmScope),
      routeSessionKey: route.sessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: route.agentId }),
      recordInboundSession,
    };
  }
  const { cfg, route, ...turn } = value;
  const assembled: RoutedAssembledChannelTurn = {
    ...turn,
    ctxPayload: applyRouteDmScope(turn.ctxPayload, route.dmScope),
    cfg,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: route.agentId }),
    recordInboundSession,
  };
  return assembled;
}

function resolveAssembledReplyPipeline(
  params: DispatchableChannelTurn,
): Pick<AssembledChannelTurn, "dispatcherOptions" | "replyOptions"> {
  const adoption = params.turnAdoptionLifecycle ?? params.replyOptions?.turnAdoptionLifecycle;
  let replyOptions = adoption
    ? { ...params.replyOptions, turnAdoptionLifecycle: adoption }
    : params.replyOptions;
  if (params.routeSessionKey !== params.ctxPayload.SessionKey) {
    replyOptions = withReplySystemEventSessionKey(replyOptions ?? {}, params.routeSessionKey);
  }
  if (!params.replyPipeline) {
    return {
      dispatcherOptions: params.dispatcherOptions,
      replyOptions,
    };
  }
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    ...params.replyPipeline,
  });
  return {
    dispatcherOptions: {
      ...replyPipeline,
      ...params.dispatcherOptions,
    },
    replyOptions: {
      onModelSelected,
      ...replyOptions,
    },
  };
}

function isExplicitlyNonVisibleChannelDelivery(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

function markChannelDeliveryErrorVisible(error: unknown): unknown {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    try {
      Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
      return error;
    } catch {
      // Fall back to a wrapper when a platform error object is non-extensible.
    }
  }
  const visibleError = new Error("visible channel reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

async function runChannelDeliveryObserver(params: {
  onDelivered: AnyChannelDeliveryAdapter["onDelivered"] | undefined;
  payload: ReplyPayload;
  info: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[1];
  result: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[2];
}): Promise<void> {
  if (!params.onDelivered) {
    return;
  }
  try {
    await params.onDelivered(params.payload, params.info, params.result);
  } catch (error: unknown) {
    throw isExplicitlyNonVisibleChannelDelivery(params.result)
      ? error
      : markChannelDeliveryErrorVisible(error);
  }
}

function resolveChannelDeliveryMessageId(
  result: ChannelDeliveryOutcome | undefined,
): string | undefined {
  return result?.receipt
    ? resolveMessageReceiptPrimaryId(result.receipt)
    : result?.messageIds?.find((messageId) => messageId.trim());
}

async function settleChannelDeliveryAttempts(params: {
  attempts: readonly PendingChannelDeliveryAttempt[];
  delivery: AnyChannelDeliveryAdapter;
  emitMessageSent?: ReturnType<typeof createMessageSentEmitter>["emitMessageSent"];
  onSettled?: (info: ChannelDeliveryInfo, result: ChannelDeliveryResult | undefined) => void;
}): Promise<void> {
  let preferredSettlementError: unknown;

  for (const attempt of params.attempts) {
    try {
      const finalized = await settleChannelDeliveryAttempt({
        attempt,
        onDelivered: params.delivery.onDelivered,
        onFinalizationError: async (error) => {
          await Promise.resolve(params.delivery.onError?.(error, attempt.info));
        },
        emitMessageSent: params.emitMessageSent,
      });
      params.onSettled?.(attempt.info, finalized);
    } catch (error: unknown) {
      // Any visible partial outcome must win over an earlier generic failure so callers
      // retain provider identity and do not retry an already-visible logical payload.
      if (
        preferredSettlementError === undefined ||
        (resolvePartialChannelDeliveryResult(error) !== undefined &&
          resolvePartialChannelDeliveryResult(preferredSettlementError) === undefined)
      ) {
        preferredSettlementError = error;
      }
    }
  }

  if (preferredSettlementError !== undefined) {
    throw toErrorObject(preferredSettlementError, "channel delivery settlement failed");
  }
}

// Failed-send custody policy: a permanent typed non-dispatch rejection is a
// proven no-send (terminal suppression, no replay, no notice); an untyped error
// after the pre-I/O claim affirms real ambiguity (unknown -> owed notice); a
// retryable typed rejection restores prepared custody so recovery can replay —
// the pre-claim already wrote unknown, and leaving it would fake ambiguity.
async function settleFailedPendingFinalDelivery(
  payload: ReplyPayload,
  error: unknown,
): Promise<void> {
  const completion = resolvePendingFinalCompletion(payload);
  if (!completion) {
    return;
  }
  if (isPlatformMessageRejectedError(error)) {
    await settlePendingFinalDelivery(completion, "suppressed", ["prepared", "queued", "unknown"]);
  } else if (isPlatformMessageNotDispatchedError(error)) {
    await settlePendingFinalDelivery(completion, "prepared", ["queued", "unknown"]);
  } else {
    await settlePendingFinalDelivery(completion, "unknown", ["queued", "unknown"]);
  }
}

async function settleChannelDeliveryAttempt(params: {
  attempt: PendingChannelDeliveryAttempt;
  onDelivered: AnyChannelDeliveryAdapter["onDelivered"] | undefined;
  onFinalizationError?: (error: unknown) => Promise<void> | void;
  emitMessageSent?: ReturnType<typeof createMessageSentEmitter>["emitMessageSent"];
}): Promise<ChannelDeliveryResult | undefined> {
  const { attempt } = params;
  if ("error" in attempt) {
    const partial = resolvePartialChannelDeliveryResult(attempt.error);
    if (!isPlatformMessageNotDispatchedError(attempt.error)) {
      params.emitMessageSent?.({
        success: false,
        content: partial?.content ?? attempt.payload.text ?? "",
        error: formatErrorMessage(attempt.error),
        messageId: resolveChannelDeliveryMessageId(partial),
      });
    }
    return undefined;
  }

  let finalized: ChannelDeliveryResult | undefined;
  try {
    const result = attempt.result;
    finalized = result
      ? result.finalization
        ? { ...result, ...(await result.finalization), finalization: undefined }
        : result
      : undefined;
  } catch (error: unknown) {
    try {
      await params.onFinalizationError?.(error);
    } catch {
      // Error observers are best-effort and must not replace the native settlement failure.
    }
    await settleFailedPendingFinalDelivery(attempt.payload, error);
    const partial = resolvePartialChannelDeliveryResult(error);
    if (!isPlatformMessageNotDispatchedError(error)) {
      params.emitMessageSent?.({
        success: false,
        content: partial?.content ?? attempt.payload.text ?? "",
        error: formatErrorMessage(error),
        messageId: resolveChannelDeliveryMessageId(partial),
      });
    }
    throw toErrorObject(error, "channel delivery finalization failed");
  }

  if (!isExplicitlyNonVisibleChannelDelivery(finalized)) {
    params.emitMessageSent?.({
      success: true,
      content: finalized?.content ?? attempt.payload.text ?? "",
      messageId: resolveChannelDeliveryMessageId(finalized),
    });
  }
  const completion = resolvePendingFinalCompletion(attempt.payload);
  if (completion) {
    await settlePendingFinalDelivery(
      completion,
      isExplicitlyNonVisibleChannelDelivery(finalized) ? "suppressed" : "delivered",
    );
  }
  await runChannelDeliveryObserver({
    onDelivered: params.onDelivered,
    payload: attempt.payload,
    info: attempt.info,
    result: finalized,
  });
  return finalized;
}

async function applyRoutedDirectMessageSending(params: {
  turn: RoutedAssembledChannelTurn;
  payload: ReplyPayload;
}): Promise<{ payload: ReplyPayload; suppression?: ChannelDeliveryResult }> {
  const hookRunner = getGlobalHookRunner();
  const hookCtx = deriveInboundMessageHookContext(params.turn.ctxPayload);
  const hookResult = await applyMessageSendingHook({
    hookRunner,
    enabled: hookRunner?.hasHooks("message_sending") ?? false,
    payload: params.payload,
    payloadSummary: summarizeOutboundPayloadForTransport(params.payload),
    to: resolveInboundReplyHookTarget(params.turn.ctxPayload, hookCtx),
    channel: params.turn.channel,
    accountId: params.turn.accountId,
    replyToId:
      params.payload.replyToId ??
      params.turn.ctxPayload.ReplyToIdFull ??
      params.turn.ctxPayload.ReplyToId,
    threadId: params.turn.ctxPayload.MessageThreadId,
    sessionKey: params.turn.routeSessionKey,
  });
  if (hookResult.cancelled) {
    return {
      payload: params.payload,
      suppression: createSuppressedChannelDeliveryResult({
        reason: "cancelled_by_message_sending_hook",
        cancelReason: hookResult.cancelReason,
        metadata: hookResult.hookMetadata,
      }),
    };
  }
  const payload = normalizeEmptyPayloadForDelivery(hookResult.payload);
  if (!payload) {
    return {
      payload: hookResult.payload,
      suppression: createSuppressedChannelDeliveryResult({
        reason: hookResult.contentRewritten
          ? "empty_after_message_sending_hook"
          : "no_visible_payload",
      }),
    };
  }
  return { payload: copyReplyPayloadMetadata(params.payload, payload) };
}

function reconcileNonVisibleChannelDeliveries(
  result: DispatchFromConfigResult,
  nonVisibleCounts: Readonly<Record<ReplyDispatchKind, number>>,
): DispatchFromConfigResult {
  const counts = {
    tool: Math.max(0, result.counts.tool - nonVisibleCounts.tool),
    block: Math.max(0, result.counts.block - nonVisibleCounts.block),
    final: Math.max(0, result.counts.final - nonVisibleCounts.final),
  };
  return {
    ...result,
    queuedFinal: result.queuedFinal && counts.final > 0,
    counts,
  };
}

function createObserveOnlyDeliveryAdapter(): ChannelEventDeliveryAdapter {
  // Observe-only turns still run the agent, but transport delivery must remain impossible for
  // every assembled-turn entry point, including direct SDK dispatch.
  return {
    deliver: async () => ({ visibleReplySent: false }),
  };
}

async function dispatchChannelTurnWithDeliveryOwner(
  ...args:
    | [params: AssembledChannelTurn, ownership: "legacy-dispatcher"]
    | [params: RoutedAssembledChannelTurn, ownership: "routed-delivery"]
): Promise<ChannelTurnResult> {
  const [params, ownership] = args;
  const replyPipeline = resolveAssembledReplyPipeline(params);
  const turnAdoptionLifecycle =
    params.turnAdoptionLifecycle ?? params.replyOptions?.turnAdoptionLifecycle;
  const delivery =
    params.admission?.kind === "observeOnly" ? createObserveOnlyDeliveryAdapter() : params.delivery;
  const pendingDeliveryAttempts: PendingChannelDeliveryAttempt[] = [];
  const normalizationSuppressionAttempts: PendingChannelDeliveryAttempt[] = [];
  const nonVisibleDeliveryCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const recordSettledDelivery = (
    info: ChannelDeliveryInfo,
    result: ChannelDeliveryResult | undefined,
  ) => {
    if (isExplicitlyNonVisibleChannelDelivery(result)) {
      nonVisibleDeliveryCounts[info.kind] += 1;
    }
  };
  let agentRunId: string | undefined;
  const onAgentRunStart = replyPipeline.replyOptions?.onAgentRunStart;
  const replyOptions = delivery.observeMessageSent
    ? {
        ...replyPipeline.replyOptions,
        onAgentRunStart: (runId: string) => {
          agentRunId = runId;
          onAgentRunStart?.(runId);
        },
      }
    : replyPipeline.replyOptions;
  const hookCtx = delivery.observeMessageSent
    ? deriveInboundMessageHookContext(params.ctxPayload)
    : undefined;
  let messageSentEmitter: ReturnType<typeof createMessageSentEmitter> | undefined;
  const getMessageSentEmitter = () => {
    if (!delivery.observeMessageSent || !hookCtx) {
      return undefined;
    }
    messageSentEmitter ??= createMessageSentEmitter({
      hookRunner: getGlobalHookRunner(),
      channel: params.channel,
      to: resolveInboundReplyHookTarget(params.ctxPayload, hookCtx),
      accountId: params.accountId,
      sessionKeyForInternalHooks: params.routeSessionKey,
      runId: agentRunId,
      isGroup: hookCtx.isGroup,
      groupId: hookCtx.groupId,
      logPrefix: "dispatchAssembledChannelTurn",
    });
    return messageSentEmitter;
  };
  return await runPreparedChannelTurnCore(
    {
      channel: params.channel,
      accountId: params.accountId,
      routeSessionKey: params.routeSessionKey,
      storePath: params.storePath,
      ctxPayload: params.ctxPayload,
      recordInboundSession: params.recordInboundSession,
      afterRecord: params.afterRecord,
      record: params.record,
      history: params.history,
      admission: params.admission,
      botLoopProtection: params.botLoopProtection,
      outboundEchoSourceId: params.outboundEchoSourceId,
      log: params.log,
      messageId: params.messageId,
      ...(turnAdoptionLifecycle
        ? {
            runDispatchLifecycle: {
              turnAdoptionLifecycle,
              onDispatchSkipped: async () => await turnAdoptionLifecycle.onAdopted(),
            },
          }
        : {}),
      runDispatch: async () => {
        let dispatchResult:
          | Awaited<ReturnType<AssembledChannelTurn["dispatchReplyWithBufferedBlockDispatcher"]>>
          | undefined;
        let dispatchError: unknown;
        try {
          dispatchResult = await runWithSessionInitConflictRetry(
            () =>
              (ownership === "routed-delivery"
                ? dispatchInboundMessageWithRoutedChannelDispatcher
                : params.dispatchReplyWithBufferedBlockDispatcher)({
                ctx: params.ctxPayload,
                cfg: params.cfg,
                ...(ownership === "routed-delivery"
                  ? {
                      ...(params.admission?.kind === "observeOnly"
                        ? { suppressOutboundHooks: true as const }
                        : {}),
                      onReplyPayloadSuppressed: async (
                        payload: ReplyPayload,
                        info: ChannelDeliveryInfo,
                        reason:
                          | "cancelled_by_reply_payload_sending_hook"
                          | "empty_after_reply_payload_sending_hook",
                      ) => {
                        await suppressPendingFinalDelivery(payload);
                        await runChannelDeliveryObserver({
                          onDelivered: delivery.onDelivered,
                          payload,
                          info,
                          result: createSuppressedChannelDeliveryResult({ reason }),
                        });
                      },
                    }
                  : {}),
                dispatcherOptions: {
                  ...replyPipeline.dispatcherOptions,
                  onSkip: (payload, info) => {
                    replyPipeline.dispatcherOptions?.onSkip?.(payload, info);
                    if (info.reason !== "channel_transform") {
                      return;
                    }
                    const { reason: _reason, ...deliveryInfo } = info;
                    normalizationSuppressionAttempts.push({
                      payload,
                      info: deliveryInfo,
                      result: createSuppressedChannelDeliveryResult({ reason: info.reason }),
                    });
                  },
                  deliver: async (payload: ReplyPayload, info: ChannelDeliveryInfo) => {
                    const preparedPayloadResult = delivery.preparePayload
                      ? await delivery.preparePayload(payload, info)
                      : payload;
                    const preparedPayload =
                      preparedPayloadResult === null
                        ? null
                        : copyReplyPayloadMetadata(payload, preparedPayloadResult);
                    if (preparedPayload === null) {
                      const suppression = createSuppressedChannelDeliveryResult({
                        reason: "no_visible_payload",
                      });
                      await suppressPendingFinalDelivery(payload);
                      await runChannelDeliveryObserver({
                        onDelivered: delivery.onDelivered,
                        payload,
                        info,
                        result: suppression,
                      });
                      recordSettledDelivery(info, suppression);
                      return suppression;
                    }
                    const declaredDurable = "durable" in delivery ? delivery.durable : undefined;
                    const durableOptions =
                      typeof declaredDurable === "function"
                        ? await declaredDurable(preparedPayload, info)
                        : declaredDurable;
                    if (durableOptions) {
                      const durable = await deliverInboundReplyWithMessageSendContextCore({
                        cfg: params.cfg,
                        channel: params.channel,
                        accountId: params.accountId,
                        agentId: params.agentId,
                        ctxPayload: params.ctxPayload,
                        payload: preparedPayload,
                        info,
                        ...durableOptions,
                      });
                      throwIfDurableInboundReplyDeliveryFailed(durable);
                      if (isDurableInboundReplyDeliveryHandled(durable)) {
                        // Durable sends already emit canonical message_sent from
                        // deliverOutboundPayloadsInternal after outbound hooks settle.
                        await runChannelDeliveryObserver({
                          onDelivered: delivery.onDelivered,
                          payload: preparedPayload,
                          info,
                          result: durable.delivery,
                        });
                        recordSettledDelivery(info, durable.delivery);
                        return durable.delivery;
                      }
                    }
                    let effectivePayload = preparedPayload;
                    let result: ChannelDeliveryResult | void = undefined;
                    let directInfo: ChannelDeliveryInfo = info;
                    try {
                      if (
                        ownership === "routed-delivery" &&
                        "deliverWithProviderMessageSending" in delivery &&
                        delivery.deliverWithProviderMessageSending
                      ) {
                        const providerInfo = {
                          ...info,
                          ...(createDirectPendingFinalCustody(effectivePayload) ??
                            NO_PENDING_FINAL_CUSTODY),
                        };
                        directInfo = providerInfo;
                        result = await delivery.deliverWithProviderMessageSending(
                          effectivePayload,
                          providerInfo,
                        );
                      } else {
                        if (
                          ownership === "routed-delivery" &&
                          params.admission?.kind !== "observeOnly"
                        ) {
                          const hook = await applyRoutedDirectMessageSending({
                            turn: params as RoutedAssembledChannelTurn,
                            payload: effectivePayload,
                          });
                          effectivePayload = hook.payload;
                          if (hook.suppression) {
                            result = hook.suppression;
                          }
                        }
                        if (!result) {
                          if (!("deliver" in delivery) || !delivery.deliver) {
                            throw new Error(
                              "channel delivery adapter is missing a direct deliverer",
                            );
                          }
                          const custody = createDirectPendingFinalCustody(effectivePayload);
                          await custody?.onPlatformSendDispatch();
                          result = await delivery.deliver(
                            effectivePayload,
                            toCoreManagedDeliveryInfo(info),
                          );
                        }
                      }
                    } catch (error: unknown) {
                      await settleFailedPendingFinalDelivery(effectivePayload, error);
                      if (delivery.observeMessageSent) {
                        await settleChannelDeliveryAttempt({
                          attempt: {
                            payload: effectivePayload,
                            info: directInfo,
                            error,
                          },
                          onDelivered: delivery.onDelivered,
                          emitMessageSent: getMessageSentEmitter()?.emitMessageSent,
                        });
                      }
                      throw error;
                    }
                    if (result?.finalization) {
                      // Finalization can reject while the buffered dispatcher is still unwinding.
                      // Observe it now; settlement still awaits the original promise and its error.
                      void result.finalization.catch(() => undefined);
                      pendingDeliveryAttempts.push({
                        payload: effectivePayload,
                        info: directInfo,
                        result,
                      });
                    } else {
                      const finalized = await settleChannelDeliveryAttempt({
                        attempt: {
                          payload: effectivePayload,
                          info: directInfo,
                          result,
                        },
                        onDelivered: delivery.onDelivered,
                        emitMessageSent: delivery.observeMessageSent
                          ? getMessageSentEmitter()?.emitMessageSent
                          : undefined,
                      });
                      recordSettledDelivery(info, finalized);
                    }
                    return result;
                  },
                  onError: delivery.onError,
                },
                toolsAllow: params.toolsAllow,
                replyOptions,
                replyResolver: params.replyResolver,
              }),
            params.sessionInitRetry
              ? {
                  retryDelaysMs: params.sessionInitRetry.delaysMs,
                  signal: params.sessionInitRetry.signal,
                  sleep: params.sessionInitRetry.sleep,
                }
              : undefined,
          );
        } catch (error: unknown) {
          dispatchError = error;
        }

        let settlementError: unknown;
        try {
          await settleChannelDeliveryAttempts({
            attempts: normalizationSuppressionAttempts,
            delivery,
          });
          await settleChannelDeliveryAttempts({
            attempts: pendingDeliveryAttempts,
            delivery,
            emitMessageSent: getMessageSentEmitter()?.emitMessageSent,
            onSettled: recordSettledDelivery,
          });
        } catch (error: unknown) {
          settlementError = error;
        }
        // Deferred settlement can carry the provider-visible receipt/content that the earlier
        // dispatch failure lacks. Preserve that partial result so callers do not retry a send
        // that the channel already accepted.
        if (
          settlementError !== undefined &&
          resolvePartialChannelDeliveryResult(settlementError) !== undefined
        ) {
          throw toErrorObject(settlementError, "channel delivery settlement failed");
        }
        if (dispatchError !== undefined) {
          throw toErrorObject(dispatchError, "channel dispatch failed");
        }
        if (settlementError !== undefined) {
          throw toErrorObject(settlementError, "channel delivery settlement failed");
        }
        return ownership === "routed-delivery"
          ? reconcileNonVisibleChannelDeliveries(dispatchResult!, nonVisibleDeliveryCounts)
          : dispatchResult!;
      },
    },
    { suppressObserveOnlyDispatch: false },
  );
}

export async function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult> {
  return await dispatchChannelTurnWithDeliveryOwner(params, "legacy-dispatcher");
}

export function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult>;
export function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelProviderOwnedMessageSendingDeliveryAdapter>,
): Promise<ChannelTurnResult>;
export function dispatchRoutedChannelTurn(params: ChannelTurnPlan): Promise<ChannelTurnResult>;
export async function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult> {
  const assembled = assembleResolvedChannelTurn(params);
  return await dispatchChannelTurnWithDeliveryOwner(
    assembled as RoutedAssembledChannelTurn,
    "routed-delivery",
  );
}
