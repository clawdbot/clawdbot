import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { runWithSessionInitConflictRetry } from "../../auto-reply/reply/session-init-conflict-retry.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
} from "../../hooks/message-hook-mappers.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { isPlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { createMessageSentEmitter } from "../../infra/outbound/message-sent-hook.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveMessageReceiptPrimaryId } from "../message/receipt.js";
import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import { recordInboundSession } from "../session.js";
import { isChannelPartialDeliveryError } from "./delivery-result.js";
import {
  deliverInboundReplyWithMessageSendContext,
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
  ChannelTurnResolved,
  ChannelTurnResult,
  PreparedChannelTurn,
} from "./types.js";

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

export function assembleResolvedChannelTurn<TDispatchResult>(
  value: ChannelTurnResolved<TDispatchResult>,
): AssembledChannelTurn | PreparedChannelTurn<TDispatchResult> {
  if (!("route" in value)) {
    return value;
  }
  if ("runDispatch" in value) {
    const { cfg, route, ...turn } = value;
    return {
      ...turn,
      ctxPayload: route.dmScope ? { ...turn.ctxPayload, DmScope: route.dmScope } : turn.ctxPayload,
      routeSessionKey: route.sessionKey,
      storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
      recordInboundSession,
    };
  }
  const { cfg, route, ...turn } = value;
  return {
    ...turn,
    ctxPayload: route.dmScope ? { ...turn.ctxPayload, DmScope: route.dmScope } : turn.ctxPayload,
    cfg,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

function resolveAssembledReplyPipeline(
  params: AssembledChannelTurn,
): Pick<AssembledChannelTurn, "dispatcherOptions" | "replyOptions"> {
  const turnAdoptionLifecycle =
    params.turnAdoptionLifecycle ?? params.replyOptions?.turnAdoptionLifecycle;
  if (!params.replyPipeline) {
    return {
      dispatcherOptions: params.dispatcherOptions,
      replyOptions: turnAdoptionLifecycle
        ? { ...params.replyOptions, turnAdoptionLifecycle }
        : params.replyOptions,
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
      ...params.replyOptions,
      ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
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
  onDelivered: ChannelEventDeliveryAdapter["onDelivered"] | undefined;
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
  delivery: ChannelEventDeliveryAdapter;
  emitMessageSent?: ReturnType<typeof createMessageSentEmitter>["emitMessageSent"];
}): Promise<void> {
  let preferredSettlementError: unknown;

  for (const attempt of params.attempts) {
    try {
      await settleChannelDeliveryAttempt({
        attempt,
        onDelivered: params.delivery.onDelivered,
        emitMessageSent: params.emitMessageSent,
      });
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

async function settleChannelDeliveryAttempt(params: {
  attempt: PendingChannelDeliveryAttempt;
  onDelivered: ChannelEventDeliveryAdapter["onDelivered"] | undefined;
  emitMessageSent?: ReturnType<typeof createMessageSentEmitter>["emitMessageSent"];
}): Promise<void> {
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
    return;
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
  await runChannelDeliveryObserver({
    onDelivered: params.onDelivered,
    payload: attempt.payload,
    info: attempt.info,
    result: finalized,
  });
}

function createObserveOnlyDeliveryAdapter(): ChannelEventDeliveryAdapter {
  // Observe-only turns still run the agent, but transport delivery must remain impossible for
  // every assembled-turn entry point, including direct SDK dispatch.
  return {
    deliver: async () => ({ visibleReplySent: false }),
  };
}

export async function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult> {
  const replyPipeline = resolveAssembledReplyPipeline(params);
  const turnAdoptionLifecycle =
    params.turnAdoptionLifecycle ?? params.replyOptions?.turnAdoptionLifecycle;
  const delivery =
    params.admission?.kind === "observeOnly" ? createObserveOnlyDeliveryAdapter() : params.delivery;
  const pendingDeliveryAttempts: PendingChannelDeliveryAttempt[] = [];
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
              params.dispatchReplyWithBufferedBlockDispatcher({
                ctx: params.ctxPayload,
                cfg: params.cfg,
                dispatcherOptions: {
                  ...replyPipeline.dispatcherOptions,
                  deliver: async (payload: ReplyPayload, info) => {
                    const preparedPayload = delivery.preparePayload
                      ? await delivery.preparePayload(payload, info)
                      : payload;
                    const durableOptions =
                      typeof delivery.durable === "function"
                        ? await delivery.durable(preparedPayload, info)
                        : delivery.durable;
                    if (durableOptions) {
                      const durable = await deliverInboundReplyWithMessageSendContext({
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
                        return durable.delivery;
                      }
                    }
                    let result: ChannelDeliveryResult | void;
                    try {
                      result = await delivery.deliver(preparedPayload, info);
                    } catch (error: unknown) {
                      if (delivery.observeMessageSent) {
                        await settleChannelDeliveryAttempt({
                          attempt: { payload: preparedPayload, info, error },
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
                      pendingDeliveryAttempts.push({ payload: preparedPayload, info, result });
                    } else if (delivery.observeMessageSent) {
                      await settleChannelDeliveryAttempt({
                        attempt: { payload: preparedPayload, info, result },
                        onDelivered: delivery.onDelivered,
                        emitMessageSent: getMessageSentEmitter()?.emitMessageSent,
                      });
                    } else {
                      await runChannelDeliveryObserver({
                        onDelivered: delivery.onDelivered,
                        payload: preparedPayload,
                        info,
                        result,
                      });
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
            attempts: pendingDeliveryAttempts,
            delivery,
            emitMessageSent: getMessageSentEmitter()?.emitMessageSent,
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
        return dispatchResult!;
      },
    },
    { suppressObserveOnlyDispatch: false },
  );
}

export { runPreparedInboundReply } from "./execution.js";
