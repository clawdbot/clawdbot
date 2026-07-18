import { clearChannelHistoryIfEnabled } from "../../auto-reply/reply/history.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordChannelBotPairLoopAndCheckSuppression } from "./bot-loop-protection.js";
import {
  EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  hasVisibleChannelTurnDispatch,
  type ChannelTurnDispatchResultLike,
  type ChannelTurnVisibleDeliverySignals,
} from "./dispatch-result.js";
import type {
  ChannelTurnAdmission,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnLogEvent,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  PreparedChannelTurn,
} from "./types.js";

const NO_ADDITIONAL_DELIVERY_SIGNALS: ChannelTurnVisibleDeliverySignals = {};
const log = createSubsystemLogger("channels/turn/execution");

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

function clearPendingHistoryAfterTurn(params?: ChannelTurnHistoryFinalizeOptions): void {
  if (!params?.isGroup || !params.historyKey || !params.historyMap || params.limit === undefined) {
    return;
  }
  clearChannelHistoryIfEnabled({
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

function isSystemChannelTurn(ctx: FinalizedMsgContext): boolean {
  return (
    ctx.Provider === "heartbeat" || ctx.Provider === "cron-event" || ctx.Provider === "exec-event"
  );
}

function maybeWarnZeroCountVisibleDispatch<TDispatchResult>(
  params: Pick<
    PreparedChannelTurn<TDispatchResult>,
    "admission" | "channel" | "ctxPayload" | "messageId" | "routeSessionKey"
  > & {
    dispatchResult: TDispatchResult;
    log?: (event: ChannelTurnLogEvent) => void;
  },
): void {
  if (params.admission?.kind === "observeOnly" || isSystemChannelTurn(params.ctxPayload)) {
    return;
  }
  const dispatchResult = params.dispatchResult as ChannelTurnDispatchResultLike;
  // The canonical visible signal includes observed delivery paths with zero queued counts.
  if (hasVisibleChannelTurnDispatch(dispatchResult, NO_ADDITIONAL_DELIVERY_SIGNALS)) {
    return;
  }
  log.warn(
    `visible channel turn dispatched with no queued reply payloads: channel=${params.channel} ` +
      `messageId=${params.messageId ?? "unknown"} sessionKey=${
        params.ctxPayload.SessionKey ?? params.routeSessionKey
      }`,
  );
  emit({
    ...params,
    event: {
      stage: "dispatch",
      event: "warning",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: params.admission?.kind ?? "dispatch",
      reason: "zero-count-visible-dispatch",
    },
  });
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

export async function runPreparedChannelTurnCore<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurn<TDispatchResult>,
  options: { suppressObserveOnlyDispatch: boolean },
): Promise<ChannelTurnResult<TDispatchResult>> {
  const trace = createDiagnosticTraceContextFromActiveScope();
  return await runWithDiagnosticTraceContext(trace, () =>
    runPreparedChannelTurnCoreInTrace(params, options),
  );
}

async function runPreparedChannelTurnCoreInTrace<
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
    await params.afterRecord?.();
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
    if (admission.kind === "observeOnly" && !options.suppressObserveOnlyDispatch) {
      await params.runDispatch();
    }
    dispatchResult =
      admission.kind === "observeOnly"
        ? resolveObserveOnlyDispatchResult(params)
        : await params.runDispatch();
    maybeWarnZeroCountVisibleDispatch({
      ...params,
      admission,
      dispatchResult,
    });
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

function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(
  params: PreparedChannelTurnWithBotLoopProtection<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(
  params: PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult>,
): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
function runPreparedChannelTurn<TDispatchResult = DispatchedChannelTurnResult["dispatchResult"]>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
async function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedChannelTurnCore(params, { suppressObserveOnlyDispatch: true });
}

export const runPreparedInboundReply = runPreparedChannelTurn;
