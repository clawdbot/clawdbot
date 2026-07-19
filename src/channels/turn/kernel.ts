import { recordChannelHistoryEntryWithMedia } from "../../auto-reply/reply/history.js";
import { toHistoryMediaEntries } from "../inbound-event/media.js";
import {
  assembleResolvedChannelTurn,
  dispatchAssembledChannelTurn as dispatchAssembledChannelTurnImpl,
  runPreparedInboundReply as runPreparedInboundReplyImpl,
} from "./lifecycle.js";

export { recordChannelBotPairLoopAndCheckSuppression } from "./bot-loop-protection.js";

export type { ChannelBotLoopProtectionFacts } from "./bot-loop-protection.js";

export {
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
export type {
  DurableInboundReplyDeliveryOptions,
  DurableInboundReplyDeliveryParams,
} from "./durable-delivery.js";
import type {
  AssembledChannelTurn,
  ChannelEventClass,
  ChannelTurnAdmission,
  ChannelTurnLogEvent,
  ChannelTurnPlan,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  NormalizedTurnInput,
  PreflightFacts,
  PreparedChannelTurn,
  RunChannelTurnParams,
} from "./types.js";

export {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "./dispatch-result.js";
export type { ChannelTurnResult } from "./types.js";

export function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult> {
  return dispatchAssembledChannelTurnImpl(params);
}

export const dispatchChannelInboundReply = dispatchAssembledChannelTurn;

export function dispatchChannelInboundTurn(plan: ChannelTurnPlan): Promise<ChannelTurnResult> {
  return dispatchAssembledChannelTurnImpl(
    assembleResolvedChannelTurn(plan) as AssembledChannelTurn,
  );
}

export const runPreparedInboundReply = runPreparedInboundReplyImpl;

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

function assertPreparedDispatchLifecycle<TDispatchResult>(
  turn: PreparedChannelTurn<TDispatchResult>,
  turnAdoptionLifecycle: RunChannelTurnParams<unknown>["turnAdoptionLifecycle"],
): void {
  const lifecycle = turn.runDispatchLifecycle;
  if (!lifecycle) {
    throw new Error(
      "runChannelInboundEvent prepared turns must declare runDispatchLifecycle when creating runDispatch",
    );
  }
  if (turnAdoptionLifecycle && lifecycle.turnAdoptionLifecycle !== turnAdoptionLifecycle) {
    throw new Error(
      "runChannelInboundEvent prepared turn runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
    );
  }
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

async function recordDroppedChannelTurnHistory(params: {
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
  await recordChannelHistoryEntryWithMedia({
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

export const recordDroppedChannelInboundHistory = recordDroppedChannelTurnHistory;

async function runChannelTurn<
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

  const resolved = assembleResolvedChannelTurn(
    await params.adapter.resolveTurn(input, eventClass, preflight),
  );
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
    if ("runDispatch" in resolved) {
      assertPreparedDispatchLifecycle(resolved, params.turnAdoptionLifecycle);
    }
    const dispatchResult = (
      "runDispatch" in resolved
        ? await runPreparedInboundReply({
            ...resolved,
            admission,
            log: params.log,
            messageId: input.id,
          })
        : await dispatchAssembledChannelTurn({
            ...resolved,
            admission,
            log: params.log,
            messageId: input.id,
            ...(params.turnAdoptionLifecycle
              ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
              : {}),
          })
    ) as ChannelTurnResult<TDispatchResult>;
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

export const runChannelInboundEvent = runChannelTurn;
