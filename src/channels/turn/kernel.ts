import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryWithMedia,
} from "../../auto-reply/reply/history.js";
import { toHistoryMediaEntries } from "../inbound-event/media.js";
import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import type { CreateChannelReplyPipelineParams } from "../message/reply-pipeline.js";
import { recordChannelBotPairLoopAndCheckSuppression } from "./bot-loop-protection.js";
import { EMPTY_CHANNEL_TURN_DISPATCH_COUNTS } from "./dispatch-result.js";
import {
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
export {
  buildChannelInboundEventContext,
  filterChannelInboundSupplementalContext,
} from "../inbound-event/context.js";
export type { BuildChannelInboundEventContextParams } from "../inbound-event/context.js";
export {
  clearChannelBotPairLoopGuardForTests,
  listTrackedChannelBotPairsForTests,
  recordChannelBotPairLoopAndCheckSuppression,
} from "./bot-loop-protection.js";
export { createChannelHistoryWindow } from "./history-window.js";
export type { ChannelHistoryWindow } from "./history-window.js";
export type { ChannelBotLoopProtectionFacts } from "./bot-loop-protection.js";
export {
  deliverDurableInboundReplyPayload,
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
export type {
  DurableInboundReplyDeliveryOptions,
  DurableInboundReplyDeliveryParams,
  DurableInboundReplyDeliveryResult,
} from "./durable-delivery.js";
import type {
  AssembledChannelTurn,
  ChannelEventClass,
  ChannelTurnAdmission,
  ChannelEventDeliveryAdapter,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnLogEvent,
  ChannelTurnResolved,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  NormalizedTurnInput,
  PreparedChannelTurn,
  PreflightFacts,
  RunChannelTurnParams,
  RunResolvedChannelTurnParams,
} from "./types.js";
export { createChannelDeliveryResultFromReceipt } from "./delivery-result.js";
export {
  EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
  type ChannelTurnDispatchResultLike,
  type ChannelTurnVisibleDeliverySignals,
} from "./dispatch-result.js";
export type {
  AccessFacts,
  AssembledChannelTurn,
  ChannelDeliveryInfo,
  ChannelDeliveryResult,
  ChannelEventClass,
  ChannelTurnAdapter,
  ChannelTurnAdmission,
  ChannelEventDeliveryAdapter,
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnDispatcherOptions,
  ChannelTurnLogEvent,
  ChannelTurnRecordOptions,
  ChannelTurnReplyPipelineOptions,
  ChannelTurnResolved,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  ConversationFacts,
  MessageFacts,
  NormalizedTurnInput,
  PreflightFacts,
  PreparedChannelTurn,
  ReplyPlanFacts,
  RouteFacts,
  RunChannelTurnParams,
  RunResolvedChannelTurnParams,
  SenderFacts,
  SupplementalContextFacts,
} from "./types.js";
export type { InboundMediaFacts } from "./types.js";

const DEFAULT_EVENT_CLASS: ChannelEventClass = {
  kind: "message",
  canStartAgentTurn: true,
};

/**
 * @deprecated Compatibility assembly for legacy buffered reply dispatchers.
 * New channel plugins should expose `defineChannelMessageAdapter(...)` from
 * `openclaw/plugin-sdk/channel-message` and route send/receive behavior through
 * the message lifecycle helpers.
 */
export function createChannelTurnReplyPipeline(
  params: CreateChannelReplyPipelineParams,
): ReturnType<typeof createChannelReplyPipeline> {
  return createChannelReplyPipeline(params);
}

function isAdmission(value: unknown): value is ChannelTurnAdmission {
  if (!value || typeof value !== "object") {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "dispatch" || kind === "observeOnly" || kind === "handled" || kind === "drop";
}

function normalizePreflight(
  value: PreflightFacts | ChannelTurnAdmission | null | undefined,
): PreflightFacts {
  if (!value) {
    return {};
  }
  if (isAdmission(value)) {
    return { admission: value };
  }
  return value;
}

function emit(params: {
  log?: (event: ChannelTurnLogEvent) => void;
  event: Omit<ChannelTurnLogEvent, "channel" | "accountId">;
  channel: string;
  accountId?: string;
}) {
  params.log?.({
    channel: params.channel,
    accountId: params.accountId,
    ...params.event,
  });
}

export function createNoopChannelEventDeliveryAdapter(): ChannelEventDeliveryAdapter {
  return {
    deliver: async () => ({
      visibleReplySent: false,
    }),
  };
}

function clearPendingHistoryAfterTurn(params?: ChannelTurnHistoryFinalizeOptions): void {
  if (!params?.isGroup || !params.historyKey || !params.historyMap || params.limit === undefined) {
    return;
  }
  clearHistoryEntriesIfEnabled({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    limit: params.limit,
  });
}

function resolveDroppedHistorySender(input: NormalizedTurnInput, preflight: PreflightFacts) {
  return (
    preflight.message?.senderLabel ??
    preflight.message?.envelopeFrom ??
    (typeof input.raw === "object" &&
    input.raw &&
    "sender" in input.raw &&
    typeof (input.raw as { sender?: unknown }).sender === "string"
      ? (input.raw as { sender: string }).sender
      : undefined) ??
    "unknown"
  );
}

function resolveDroppedHistoryBody(input: NormalizedTurnInput, preflight: PreflightFacts) {
  return (
    preflight.message?.bodyForAgent ??
    preflight.message?.body ??
    preflight.message?.rawBody ??
    input.textForAgent ??
    input.rawText
  );
}

export async function recordDroppedChannelTurnHistory(params: {
  input: NormalizedTurnInput;
  preflight: PreflightFacts;
  admission?: ChannelTurnAdmission;
}): Promise<void> {
  const admission = params.admission ?? params.preflight.admission;
  if (admission?.kind !== "drop") {
    return;
  }
  const history = params.preflight.history;
  if (!history || history.limit <= 0 || !(history.recordOnDrop || admission.recordHistory)) {
    return;
  }
  const body = resolveDroppedHistoryBody(params.input, params.preflight);
  const entry =
    body.trim().length > 0
      ? {
          sender: resolveDroppedHistorySender(params.input, params.preflight),
          body,
          timestamp: params.input.timestamp,
          messageId: params.input.id,
        }
      : null;
  const media = params.preflight.media;
  await recordPendingHistoryEntryWithMedia({
    historyMap: history.historyMap,
    historyKey: history.key,
    limit: history.limit,
    entry,
    mediaLimit: history.mediaLimit,
    messageId: params.input.id,
    shouldRecord: history.shouldRecord,
    media:
      typeof media === "function"
        ? async () => toHistoryMediaEntries(await media(), { messageId: params.input.id })
        : toHistoryMediaEntries(media, { messageId: params.input.id }),
  });
}

function resolveAssembledReplyPipeline(
  params: AssembledChannelTurn,
): Pick<AssembledChannelTurn, "dispatcherOptions" | "replyOptions"> {
  if (!params.replyPipeline) {
    return {
      dispatcherOptions: params.dispatcherOptions,
      replyOptions: params.replyOptions,
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
    },
  };
}

function resolveObserveOnlyDispatchResult<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): TDispatchResult {
  return (params.observeOnlyDispatchResult ?? {
    queuedFinal: false,
    counts: EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  }) as TDispatchResult;
}

function resolveBotLoopProtectionDrop<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): ChannelTurnResult<TDispatchResult> | undefined {
  if (!params.botLoopProtection) {
    return undefined;
  }
  const botLoopResult = recordChannelBotPairLoopAndCheckSuppression(params.botLoopProtection);
  if (!botLoopResult.suppressed) {
    return undefined;
  }
  const admission: ChannelTurnAdmission = { kind: "drop", reason: "bot-loop-protection" };
  emit({
    ...params,
    event: {
      stage: "authorize",
      event: "drop",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: admission.kind,
      reason: admission.reason,
    },
  });
  return {
    admission,
    dispatched: false,
    ctxPayload: params.ctxPayload,
    routeSessionKey: params.routeSessionKey,
  };
}

type AssembledChannelTurnWithBotLoopProtection = AssembledChannelTurn & {
  botLoopProtection: NonNullable<AssembledChannelTurn["botLoopProtection"]>;
};

type AssembledChannelTurnWithoutBotLoopProtection = Omit<
  AssembledChannelTurn,
  "botLoopProtection"
> & {
  botLoopProtection?: undefined;
};

export function dispatchAssembledChannelTurn(
  params: AssembledChannelTurnWithBotLoopProtection,
): Promise<ChannelTurnResult>;
export function dispatchAssembledChannelTurn(
  params: AssembledChannelTurnWithoutBotLoopProtection,
): Promise<DispatchedChannelTurnResult>;
export function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult>;
export async function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult> {
  const replyPipeline = resolveAssembledReplyPipeline(params);
  return await runPreparedChannelTurnCore(
    {
      channel: params.channel,
      accountId: params.accountId,
      routeSessionKey: params.routeSessionKey,
      storePath: params.storePath,
      ctxPayload: params.ctxPayload,
      recordInboundSession: params.recordInboundSession,
      record: params.record,
      history: params.history,
      admission: params.admission,
      botLoopProtection: params.botLoopProtection,
      log: params.log,
      messageId: params.messageId,
      runDispatch: async () =>
        await params.dispatchReplyWithBufferedBlockDispatcher({
          ctx: params.ctxPayload,
          cfg: params.cfg,
          dispatcherOptions: {
            ...replyPipeline.dispatcherOptions,
            deliver: async (payload: ReplyPayload, info) => {
              const preparedPayload = params.delivery.preparePayload
                ? await params.delivery.preparePayload(payload, info)
                : payload;
              const durableOptions =
                typeof params.delivery.durable === "function"
                  ? await params.delivery.durable(preparedPayload, info)
                  : params.delivery.durable;
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
                  await params.delivery.onDelivered?.(preparedPayload, info, durable.delivery);
                  return durable.delivery;
                }
              }
              const result = await params.delivery.deliver(preparedPayload, info);
              await params.delivery.onDelivered?.(preparedPayload, info, result);
              return result;
            },
            onError: params.delivery.onError,
          },
          replyOptions: replyPipeline.replyOptions,
          replyResolver: params.replyResolver,
        }),
    },
    { suppressObserveOnlyDispatch: false },
  );
}

function isPreparedChannelTurn<TDispatchResult>(
  value: ChannelTurnResolved<TDispatchResult>,
): value is PreparedChannelTurn<TDispatchResult> & {
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
} {
  return "runDispatch" in value;
}

async function dispatchResolvedChannelTurn<TDispatchResult>(
  params: ChannelTurnResolved<TDispatchResult> & {
    admission: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
    log?: (event: ChannelTurnLogEvent) => void;
    messageId?: string;
  },
): Promise<ChannelTurnResult<TDispatchResult>> {
  if (isPreparedChannelTurn(params)) {
    return await runPreparedChannelTurn(params);
  }
  return (await dispatchAssembledChannelTurn(params)) as ChannelTurnResult<TDispatchResult>;
}

async function runPreparedChannelTurnCore<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurn<TDispatchResult>,
  options: { suppressObserveOnlyDispatch: boolean },
): Promise<ChannelTurnResult<TDispatchResult>> {
  const admission = params.admission ?? ({ kind: "dispatch" } as const);
  const botLoopDrop = resolveBotLoopProtectionDrop(params);
  if (botLoopDrop) {
    clearPendingHistoryAfterTurn(params.history);
    return botLoopDrop;
  }
  emit({
    ...params,
    event: {
      stage: "record",
      event: "start",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: admission.kind,
    },
  });
  try {
    await params.recordInboundSession({
      storePath: params.storePath,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      ctx: params.ctxPayload,
      groupResolution: params.record?.groupResolution,
      createIfMissing: params.record?.createIfMissing,
      updateLastRoute: params.record?.updateLastRoute,
      onRecordError: params.record?.onRecordError ?? (() => undefined),
      trackSessionMetaTask: params.record?.trackSessionMetaTask,
    });
    emit({
      ...params,
      event: {
        stage: "record",
        event: "done",
        messageId: params.messageId,
        sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
        admission: admission.kind,
      },
    });
  } catch (err) {
    emit({
      ...params,
      event: {
        stage: "record",
        event: "error",
        messageId: params.messageId,
        sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
        admission: admission.kind,
        error: err,
      },
    });
    try {
      await params.onPreDispatchFailure?.(err);
    } catch {
      // Preserve the original session-recording error.
    }
    throw err;
  }

  emit({
    ...params,
    event: {
      stage: "dispatch",
      event: "start",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: admission.kind,
    },
  });
  let dispatchResult: TDispatchResult;
  try {
    dispatchResult =
      options.suppressObserveOnlyDispatch && admission.kind === "observeOnly"
        ? resolveObserveOnlyDispatchResult(params)
        : await params.runDispatch();
  } catch (err) {
    emit({
      ...params,
      event: {
        stage: "dispatch",
        event: "error",
        messageId: params.messageId,
        sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
        admission: admission.kind,
        error: err,
      },
    });
    throw err;
  }
  emit({
    ...params,
    event: {
      stage: "dispatch",
      event: "done",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: admission.kind,
    },
  });
  clearPendingHistoryAfterTurn(params.history);

  return {
    admission,
    dispatched: true,
    ctxPayload: params.ctxPayload,
    routeSessionKey: params.routeSessionKey,
    dispatchResult,
  };
}

type PreparedChannelTurnWithBotLoopProtection<TDispatchResult> =
  PreparedChannelTurn<TDispatchResult> & {
    botLoopProtection: NonNullable<PreparedChannelTurn<TDispatchResult>["botLoopProtection"]>;
  };

type PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult> = Omit<
  PreparedChannelTurn<TDispatchResult>,
  "botLoopProtection"
> & {
  botLoopProtection?: undefined;
};

export function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurnWithBotLoopProtection<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult>,
): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
export function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedChannelTurnCore(params, { suppressObserveOnlyDispatch: true });
}

export async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<TRaw, TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  emit({
    ...params,
    event: { stage: "ingest", event: "start" },
  });
  const input = await params.adapter.ingest(params.raw);
  if (!input) {
    const admission: ChannelTurnAdmission = { kind: "drop", reason: "ingest-null" };
    emit({
      ...params,
      event: {
        stage: "ingest",
        event: "drop",
        admission: admission.kind,
        reason: admission.reason,
      },
    });
    return { admission, dispatched: false };
  }
  emit({
    ...params,
    event: { stage: "ingest", event: "done", messageId: input.id },
  });

  const eventClass = (await params.adapter.classify?.(input)) ?? DEFAULT_EVENT_CLASS;
  if (!eventClass.canStartAgentTurn) {
    const admission: ChannelTurnAdmission = {
      kind: "handled",
      reason: `event:${eventClass.kind}`,
    };
    emit({
      ...params,
      event: {
        stage: "classify",
        event: "handled",
        messageId: input.id,
        admission: admission.kind,
        reason: admission.reason,
      },
    });
    return { admission, dispatched: false };
  }

  const preflight = normalizePreflight(await params.adapter.preflight?.(input, eventClass));
  const preflightAdmission = preflight.admission;
  if (
    preflightAdmission &&
    preflightAdmission.kind !== "dispatch" &&
    preflightAdmission.kind !== "observeOnly"
  ) {
    await recordDroppedChannelTurnHistory({
      input,
      preflight,
      admission: preflightAdmission,
    });
    emit({
      ...params,
      event: {
        stage: "preflight",
        event: preflightAdmission.kind === "handled" ? "handled" : "drop",
        messageId: input.id,
        admission: preflightAdmission.kind,
        reason: preflightAdmission.reason,
      },
    });
    return { admission: preflightAdmission, dispatched: false };
  }

  const resolved = await params.adapter.resolveTurn(input, eventClass, preflight);
  emit({
    ...params,
    accountId: resolved.accountId ?? params.accountId,
    event: {
      stage: "assemble",
      event: "done",
      messageId: input.id,
      sessionKey: resolved.routeSessionKey,
      admission: resolved.admission?.kind ?? "dispatch",
    },
  });

  const admission = resolved.admission ?? preflightAdmission ?? ({ kind: "dispatch" } as const);
  let result: ChannelTurnResult<TDispatchResult>;
  try {
    const dispatchResult = await dispatchResolvedChannelTurn(
      admission.kind === "observeOnly"
        ? {
            ...resolved,
            delivery: createNoopChannelEventDeliveryAdapter(),
            admission,
            log: params.log,
            messageId: input.id,
          }
        : {
            ...resolved,
            admission,
            log: params.log,
            messageId: input.id,
          },
    );
    result = dispatchResult.dispatched ? { ...dispatchResult, admission } : dispatchResult;
  } catch (err) {
    const failedResult: ChannelTurnResult<TDispatchResult> = {
      admission,
      dispatched: false,
      ctxPayload: resolved.ctxPayload,
      routeSessionKey: resolved.routeSessionKey,
    };
    try {
      await params.adapter.onFinalize?.(failedResult);
    } catch {
      // Preserve the original dispatch error.
    }
    emit({
      ...params,
      accountId: resolved.accountId ?? params.accountId,
      event: {
        stage: "finalize",
        event: "done",
        messageId: input.id,
        sessionKey: resolved.routeSessionKey,
        admission: admission.kind,
      },
    });
    throw err;
  }

  try {
    await params.adapter.onFinalize?.(result);
    emit({
      ...params,
      accountId: resolved.accountId ?? params.accountId,
      event: {
        stage: "finalize",
        event: "done",
        messageId: input.id,
        sessionKey: resolved.routeSessionKey,
        admission: admission.kind,
      },
    });
  } catch (err) {
    emit({
      ...params,
      accountId: resolved.accountId ?? params.accountId,
      event: {
        stage: "finalize",
        event: "error",
        messageId: input.id,
        sessionKey: resolved.routeSessionKey,
        admission: admission.kind,
        error: err,
      },
    });
    throw err;
  }

  return result;
}

export async function runResolvedChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunResolvedChannelTurnParams<TRaw, TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runChannelTurn({
    channel: params.channel,
    accountId: params.accountId,
    raw: params.raw,
    log: params.log,
    adapter: {
      ingest: (raw) => (typeof params.input === "function" ? params.input(raw) : params.input),
      resolveTurn: params.resolveTurn,
    },
  });
}
