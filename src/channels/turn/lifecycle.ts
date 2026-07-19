import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { runWithSessionInitConflictRetry } from "../../auto-reply/reply/session-init-conflict-retry.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import { recordInboundSession } from "../session.js";
import {
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
import { runPreparedChannelTurnCore } from "./execution.js";
import type {
  AssembledChannelTurn,
  ChannelEventDeliveryAdapter,
  ChannelTurnResolved,
  ChannelTurnResult,
  PreparedChannelTurn,
} from "./types.js";

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
      runDispatch: async () =>
        await runWithSessionInitConflictRetry(
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
                      await runChannelDeliveryObserver({
                        onDelivered: delivery.onDelivered,
                        payload: preparedPayload,
                        info,
                        result: durable.delivery,
                      });
                      return durable.delivery;
                    }
                  }
                  const result = await delivery.deliver(preparedPayload, info);
                  await runChannelDeliveryObserver({
                    onDelivered: delivery.onDelivered,
                    payload: preparedPayload,
                    info,
                    result,
                  });
                  return result;
                },
                onError: delivery.onError,
              },
              toolsAllow: params.toolsAllow,
              replyOptions: replyPipeline.replyOptions,
              replyResolver: params.replyResolver,
            }),
          params.sessionInitRetry
            ? {
                retryDelaysMs: params.sessionInitRetry.delaysMs,
                signal: params.sessionInitRetry.signal,
                sleep: params.sessionInitRetry.sleep,
              }
            : undefined,
        ),
    },
    { suppressObserveOnlyDispatch: false },
  );
}

export { runPreparedInboundReply } from "./execution.js";
