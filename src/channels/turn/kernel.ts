import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { clearHistoryEntriesIfEnabled } from "../../auto-reply/reply/history.js";
import { EMPTY_CHANNEL_TURN_DISPATCH_COUNTS } from "./dispatch-result.js";
export { buildChannelTurnContext, filterChannelTurnSupplementalContext } from "./context.js";
export type { BuildChannelTurnContextParams } from "./context.js";
import type {
  AssembledChannelTurn,
  ChannelEventClass,
  ChannelTurnAdmission,
  ChannelTurnDeliveryAdapter,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnLogEvent,
  ChannelTurnResolved,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  PreparedChannelTurn,
  PreflightFacts,
  RunChannelTurnParams,
  RunResolvedChannelTurnParams,
} from "./types.js";
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
  ChannelTurnDeliveryAdapter,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnDispatcherOptions,
  ChannelTurnLogEvent,
  ChannelTurnRecordOptions,
  ChannelTurnResolved,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  ConversationFacts,
  InboundMediaFacts,
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

const DEFAULT_EVENT_CLASS: ChannelEventClass = {
  kind: "message",
  canStartAgentTurn: true,
};

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

export function createNoopChannelTurnDeliveryAdapter(): ChannelTurnDeliveryAdapter {
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

function resolveObserveOnlyDispatchResult<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): TDispatchResult {
  return (params.observeOnlyDispatchResult ?? {
    queuedFinal: false,
    counts: EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  }) as TDispatchResult;
}

export async function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<DispatchedChannelTurnResult> {
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
      log: params.log,
      messageId: params.messageId,
      runDispatch: async () =>
        await params.dispatchReplyWithBufferedBlockDispatcher({
          ctx: params.ctxPayload,
          cfg: params.cfg,
          dispatcherOptions: {
            ...params.dispatcherOptions,
            deliver: async (payload: ReplyPayload, info) => {
              await params.delivery.deliver(payload, info);
            },
            onError: params.delivery.onError,
          },
          replyOptions: params.replyOptions,
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
): Promise<DispatchedChannelTurnResult<TDispatchResult>> {
  if (isPreparedChannelTurn(params)) {
    return await runPreparedChannelTurn(params);
  }
  return (await dispatchAssembledChannelTurn(
    params,
  )) as DispatchedChannelTurnResult<TDispatchResult>;
}

async function runPreparedChannelTurnCore<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurn<TDispatchResult>,
  options: { suppressObserveOnlyDispatch: boolean },
): Promise<DispatchedChannelTurnResult<TDispatchResult>> {
  const admission = params.admission ?? ({ kind: "dispatch" } as const);
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

export async function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<DispatchedChannelTurnResult<TDispatchResult>> {
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
            delivery: createNoopChannelTurnDeliveryAdapter(),
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
    result = {
      ...dispatchResult,
      admission,
    };
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
