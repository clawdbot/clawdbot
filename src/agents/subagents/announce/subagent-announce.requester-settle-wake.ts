/**
 * Durable top-level requester settle wake delivery.
 *
 * Lifecycle owns the persisted outbox state on retained subagent run rows;
 * this module selects a drained wave and delivers its synthesized wake.
 */
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { logWarn } from "../../../logger.js";
import { getSharedGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  getLatestSubagentRunByChildSessionKey,
  hasDescendantRunAwaitingSettle,
  listSubagentRunsForRequester,
} from "../registry/subagent-registry-read.js";
import type {
  RequesterSettleWakeState,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";
import { hasSubagentRunEnded } from "../registry/subagent-run-liveness.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  buildChildCompletionFindings,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
} from "./subagent-announce-output.js";
import { hasUsableSessionEntry } from "./subagent-announce.js";

export type RequesterSettleWakeBatchState = Omit<RequesterSettleWakeState, "retireAfterSettle">;

const REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS = 3;
const REQUESTER_SETTLE_WAKE_MAX_AMBIGUOUS_REPLAYS = 3;
const REQUESTER_SETTLE_WAKE_MAX_DEFERRALS = 10;
const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;
const activeRequesterSettleWakeBatches = new Set<string>();

function buildRequesterSettleWakeMessage(params: {
  findings?: string;
  requireVisibleReply: boolean;
  modelRouteChange?: string;
  preserveModelRouteNotice: boolean;
}): string {
  return [
    "[Subagent Context] Every subagent spawned from this session has now settled — none are still running or awaiting completion delivery.",
    "[Subagent Context] Do not keep waiting or call sessions_yield again for this batch; no further completion events will arrive.",
    "[Subagent Context] Review the completion results and send your consolidated final answer to the user now.",
    params.requireVisibleReply
      ? "[Subagent Context] Child completion delivery is internal; the original user request still requires your visible final answer."
      : `[Subagent Context] Reply ONLY: ${SILENT_REPLY_TOKEN} only if you already delivered the consolidated final answer for this batch.`,
    ...(params.modelRouteChange
      ? [
          params.modelRouteChange,
          params.preserveModelRouteNotice
            ? "[Subagent Context] Preserve this runtime-authored model-route change notice in your final answer."
            : "[Subagent Context] Keep this runtime-authored model-route change notice internal on this shared surface.",
        ]
      : []),
    "",
    params.findings ??
      "(each child result was announced individually in earlier completion events)",
  ].join("\n");
}

function buildConnectedSettledWave(
  candidates: readonly SubagentRunRecord[],
  settledEntry: SubagentRunRecord,
): SubagentRunRecord[] {
  const targetIndex = candidates.findIndex((entry) => entry.runId === settledEntry.runId);
  const target = candidates[targetIndex];
  if (!target) {
    return [];
  }

  const sorted = candidates
    .map((entry, originalIndex) => ({
      entry,
      originalIndex,
      endedAt:
        typeof entry.execution.endedAt === "number"
          ? entry.execution.endedAt
          : Number.MAX_SAFE_INTEGER,
    }))
    .toSorted(
      (a, b) =>
        a.entry.createdAt - b.entry.createdAt ||
        a.endedAt - b.endedAt ||
        a.originalIndex - b.originalIndex,
    );
  const first = sorted[0];
  if (!first) {
    return [];
  }

  let componentStart = 0;
  let componentEnd = first.endedAt;
  let containsTarget = first.originalIndex === targetIndex;
  for (let index = 1; index <= sorted.length; index += 1) {
    const next = sorted[index];
    // Interval-graph components are contiguous after sorting by spawn time.
    // Spawn time, rather than execution admission, keeps capacity-queued siblings together.
    if (!next || next.entry.createdAt > componentEnd) {
      if (containsTarget) {
        const component = sorted
          .slice(componentStart, index)
          .filter((item) => item.originalIndex !== targetIndex)
          .toSorted((a, b) => a.originalIndex - b.originalIndex);
        return [target, ...component.map((item) => item.entry)];
      }
      if (!next) {
        break;
      }
      componentStart = index;
      componentEnd = next.endedAt;
      containsTarget = next.originalIndex === targetIndex;
      continue;
    }
    componentEnd = Math.max(componentEnd, next.endedAt);
    containsTarget ||= next.originalIndex === targetIndex;
  }
  return [];
}

function readSharedBatchState(batch: readonly SubagentRunRecord[]): RequesterSettleWakeBatchState {
  const states = batch
    .map((entry) => entry.requesterSettleWake)
    .filter((state): state is RequesterSettleWakeState => Boolean(state));
  const dispatching = states.find((state) => state.status === "dispatching");
  const source = dispatching ?? states[0];
  return {
    status: source?.status ?? "pending",
    attemptCount: Math.max(0, ...states.map((state) => state.attemptCount)),
    ...(source?.replayCount !== undefined ? { replayCount: source.replayCount } : {}),
    ...(source?.nextAttemptAt !== undefined ? { nextAttemptAt: source.nextAttemptAt } : {}),
    ...(source?.batchRunIds ? { batchRunIds: [...source.batchRunIds] } : {}),
    ...(states.some((state) => state.requesterYieldBatch === true)
      ? { requesterYieldBatch: true }
      : {}),
    ...(states.some((state) => state.afterRequesterYield === true)
      ? { afterRequesterYield: true }
      : {}),
    ...(source?.rearmGeneration !== undefined ? { rearmGeneration: source.rearmGeneration } : {}),
    ...(source?.lastError !== undefined ? { lastError: source.lastError } : {}),
    deferralCount: Math.max(0, ...states.map((state) => state.deferralCount ?? 0)),
  };
}

function deferRequesterSettleWakeBatch(params: {
  batchRunIds: readonly string[];
  state: RequesterSettleWakeBatchState;
  transitionBatch: (runIds: readonly string[], state: RequesterSettleWakeBatchState) => void;
  completeBatch(
    runIds: readonly string[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
  ): void;
}): void {
  const deferralCount = (params.state.deferralCount ?? 0) + 1;
  if (deferralCount >= REQUESTER_SETTLE_WAKE_MAX_DEFERRALS) {
    completeRequesterSettleWakeBatch({
      runIds: params.batchRunIds,
      state: params.state,
      completeBatch: (runIds, rearmGeneration, delivery) =>
        params.completeBatch(runIds, rearmGeneration, delivery),
      delivery: {
        delivered: false,
        path: "none",
        error: "requester settle wake deferred too many times",
      },
    });
    return;
  }
  params.transitionBatch(params.batchRunIds, {
    status: params.state.status,
    attemptCount: params.state.attemptCount,
    ...(params.state.replayCount !== undefined ? { replayCount: params.state.replayCount } : {}),
    nextAttemptAt: Math.max(
      params.state.nextAttemptAt ?? 0,
      Date.now() + REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[0],
    ),
    batchRunIds: [...params.batchRunIds],
    ...(params.state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
    ...(params.state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
    ...(params.state.rearmGeneration !== undefined
      ? { rearmGeneration: params.state.rearmGeneration }
      : {}),
    ...(params.state.lastError !== undefined ? { lastError: params.state.lastError } : {}),
    deferralCount,
  });
}

function completeRequesterSettleWakeBatch(params: {
  runIds: readonly string[];
  state: RequesterSettleWakeBatchState;
  delivery?: SubagentAnnounceDeliveryResult;
  completeBatch(
    runIds: readonly string[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
  ): void;
}): void {
  if (params.state.rearmGeneration === undefined) {
    params.completeBatch(params.runIds, undefined, params.delivery);
    return;
  }
  params.completeBatch(params.runIds, params.state.rearmGeneration, params.delivery);
}

/**
 * Wakes a registry-less top-level requester once its last spawned child
 * reaches terminal settle. Durable state transitions happen synchronously
 * through lifecycle-owned callbacks before and after every async delivery.
 */
export async function maybeWakeRequesterAfterAllChildrenSettled(params: {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  settledEntry: SubagentRunRecord;
  transitionBatch: (runIds: readonly string[], state: RequesterSettleWakeBatchState) => void;
  completeBatch(
    runIds: readonly string[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
  ): void;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }
  const completeBatch = (
    runIds: readonly string[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
  ): void => {
    if (rearmGeneration === undefined) {
      params.completeBatch(runIds, undefined, delivery);
      return;
    }
    params.completeBatch(runIds, rearmGeneration, delivery);
  };
  const requesterSessionKey = params.requesterSessionKey.trim();
  const cfg = getRuntimeConfig();
  const requesterAgentId = resolveSubagentRequesterAgentId(cfg, params.settledEntry);
  const initialState = params.settledEntry.requesterSettleWake;
  if (!requesterSessionKey || !initialState) {
    return false;
  }
  const admittedRearmGeneration = initialState.rearmGeneration;
  if (isCronSessionKey(requesterSessionKey)) {
    completeRequesterSettleWakeBatch({
      runIds: [params.settledEntry.runId],
      state: initialState,
      completeBatch,
    });
    return false;
  }

  const listedRuns = listSubagentRunsForRequester(requesterSessionKey, {
    requesterAgentId,
  });
  const requesterRuns = Array.isArray(listedRuns) ? listedRuns : [];
  const currentSettledEntry =
    requesterRuns.find((entry) => entry.runId === params.settledEntry.runId) ?? params.settledEntry;
  const currentState = currentSettledEntry.requesterSettleWake;
  // A requester yield may re-arm this row while runtime loading is in flight.
  // Only the admitted generation may inspect descendants or mutate its batch.
  if (!currentState || currentState.rearmGeneration !== admittedRearmGeneration) {
    return false;
  }
  const requesterHasUnsettledDescendants = () =>
    hasDescendantRunAwaitingSettle(
      requesterSessionKey,
      currentSettledEntry.runId,
      requesterAgentId,
    );

  const frozenBatchRunIds = currentState.batchRunIds;
  const currentRearmGeneration = currentState.rearmGeneration;
  const hasUnsettledDescendants = requesterHasUnsettledDescendants();
  if ((!frozenBatchRunIds || frozenBatchRunIds.length === 0) && hasUnsettledDescendants) {
    return false;
  }
  let settledBatch: SubagentRunRecord[];
  if (frozenBatchRunIds && frozenBatchRunIds.length > 0) {
    const runsById = new Map(requesterRuns.map((entry) => [entry.runId, entry]));
    // Retired rows no longer own completion, but every surviving frozen member
    // must be terminal before this batch can wake its requester.
    settledBatch = frozenBatchRunIds
      .map((runId) => runsById.get(runId))
      .filter(
        (entry): entry is SubagentRunRecord =>
          Boolean(entry?.requesterSettleWake) &&
          entry?.requesterSettleWake?.rearmGeneration === currentRearmGeneration,
      );
    if (
      settledBatch.some(
        (entry) => entry.execution.status === "running" || !hasSubagentRunEnded(entry),
      )
    ) {
      return false;
    }
  } else {
    settledBatch = buildConnectedSettledWave(
      requesterRuns.filter(
        (entry) =>
          entry.requesterSettleWake &&
          entry.execution.status !== "running" &&
          hasSubagentRunEnded(entry),
      ),
      currentSettledEntry,
    );
  }
  if (settledBatch.length === 0) {
    return false;
  }

  const batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();
  const selectedState = readSharedBatchState(settledBatch);
  if (hasUnsettledDescendants) {
    if (frozenBatchRunIds && frozenBatchRunIds.length > 0) {
      deferRequesterSettleWakeBatch({
        batchRunIds,
        state: selectedState,
        transitionBatch: params.transitionBatch,
        completeBatch,
      });
    }
    return false;
  }
  const requiredSettled = settledBatch.filter((entry) => entry.expectsCompletionMessage === true);
  const hasUndeliveredRequiredCompletion = requiredSettled.some(
    (entry) => entry.delivery?.status !== "delivered",
  );
  // A yielded batch owns a rearm generation even when its child settles later.
  // Otherwise a delivered single child clears the batch before its requester wakes.
  const requesterYieldedAfterDelivery =
    selectedState.afterRequesterYield === true ||
    (selectedState.requesterYieldBatch === true && selectedState.rearmGeneration !== undefined);
  if (
    requiredSettled.length === 0 ||
    (requiredSettled.length < 2 &&
      !hasUndeliveredRequiredCompletion &&
      !requesterYieldedAfterDelivery) ||
    getSubagentDepthFromSessionStore(requesterSessionKey, {
      cfg,
      agentId: requesterAgentId,
    }) >= 1
  ) {
    completeRequesterSettleWakeBatch({
      runIds: batchRunIds,
      state: selectedState,
      completeBatch,
    });
    return false;
  }

  const { entry: requesterEntry } = loadRequesterSessionEntry(
    requesterSessionKey,
    requesterAgentId,
  );
  if (!hasUsableSessionEntry(requesterEntry)) {
    completeRequesterSettleWakeBatch({
      runIds: batchRunIds,
      state: selectedState,
      completeBatch,
      delivery: { delivered: false, path: "none", error: "requester session unavailable" },
    });
    return false;
  }

  const findings = buildChildCompletionFindings(
    dedupeLatestChildCompletionRows(
      filterCurrentDirectChildCompletionRows(settledBatch, {
        requesterSessionKey,
        requesterAgentId,
        getLatestSubagentRunByChildSessionKey,
      }),
    ),
  );
  const requesterSessionOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const directOrigin = resolveAnnounceOrigin(requesterEntry, requesterSessionOrigin);
  const terminalReply = currentSettledEntry.completion?.terminalReply;
  const modelRouteChange =
    terminalReply?.disposition === "visible" ? terminalReply.modelRouteChange : undefined;
  const completionChannel = normalizeMessageChannel(directOrigin?.channel);
  const wakeMessage = buildRequesterSettleWakeMessage({
    findings,
    requireVisibleReply: requesterYieldedAfterDelivery,
    modelRouteChange,
    preserveModelRouteNotice: !completionChannel || !isDeliverableMessageChannel(completionChannel),
  });
  const wakeKeyBase = [
    `requester-settle:${requesterAgentId ?? "unknown"}:${requesterSessionKey}:${batchRunIds.join(",")}`,
    selectedState.rearmGeneration === undefined
      ? undefined
      : `yield-${selectedState.rearmGeneration}`,
  ]
    .filter(Boolean)
    .join(":");
  if (activeRequesterSettleWakeBatches.has(wakeKeyBase)) {
    return false;
  }
  activeRequesterSettleWakeBatches.add(wakeKeyBase);

  try {
    if (params.signal?.aborted) {
      return false;
    }
    let state = readSharedBatchState(settledBatch);
    if (!settledBatch.some((entry) => entry.requesterSettleWake)) {
      return false;
    }
    if ((state.nextAttemptAt ?? 0) > Date.now()) {
      // Lifecycle owns the durable deadline timer and re-admits root work.
      // Returning here keeps restart/suspend drains free during backoff.
      return false;
    }
    // A requester may spawn more work while this durable batch is waiting
    // or replaying. Keep the frozen batch pending until the new work drains.
    if (requesterHasUnsettledDescendants()) {
      deferRequesterSettleWakeBatch({
        batchRunIds,
        state,
        transitionBatch: params.transitionBatch,
        completeBatch,
      });
      return false;
    }

    let attemptIndex: number;
    if (state.status === "dispatching") {
      // Restart after admission replays the same idempotency key. The gateway
      // can return the already-completed turn without creating a duplicate.
      attemptIndex = Math.max(0, state.attemptCount - 1);
    } else {
      if (state.attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS) {
        completeRequesterSettleWakeBatch({
          runIds: batchRunIds,
          state,
          completeBatch,
          delivery: {
            delivered: false,
            path: "none",
            error: state.lastError ?? "requester settle wake attempts exhausted",
          },
        });
        return false;
      }
      attemptIndex = state.attemptCount;
      state = {
        status: "dispatching",
        attemptCount: state.attemptCount + 1,
        batchRunIds,
        ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
        ...(state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
        ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
      };
      params.transitionBatch(batchRunIds, state);
    }

    let delivery: Awaited<ReturnType<typeof deliverSubagentAnnouncement>>;
    try {
      delivery = await deliverSubagentAnnouncement({
        requesterSessionKey,
        requesterAgentId,
        triggerMessage: wakeMessage,
        steerMessage: wakeMessage,
        summaryLine: "all spawned subagents settled",
        requesterSessionOrigin,
        requesterOrigin: requesterSessionOrigin,
        directOrigin,
        sourceSessionKey: currentSettledEntry.childSessionKey,
        sourceChannel: INTERNAL_MESSAGE_CHANNEL,
        sourceTool: "subagent_announce",
        targetRequesterSessionKey: requesterSessionKey,
        requesterIsSubagent: false,
        expectsCompletionMessage: false,
        requireDirectDelivery: true,
        ...(requesterYieldedAfterDelivery ? { requireVisibleReply: true } : {}),
        directIdempotencyKey: buildAnnounceIdempotencyKey(
          attemptIndex === 0 ? wakeKeyBase : `${wakeKeyBase}:retry-${attemptIndex}`,
        ),
        signal: params.signal,
        resolveGatewayContext: getSharedGatewayContextResolver(settledBatch),
      });
    } catch (error) {
      // A transport exception can arrive after gateway admission. Replay the
      // same persisted idempotency key; only a known no-turn result may rotate it.
      const lastError = error instanceof Error ? error.message : String(error);
      const replayCount = (state.replayCount ?? 0) + 1;
      const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[replayCount - 1];
      if (
        replayCount >= REQUESTER_SETTLE_WAKE_MAX_AMBIGUOUS_REPLAYS ||
        retryDelayMs === undefined
      ) {
        completeRequesterSettleWakeBatch({
          runIds: batchRunIds,
          state,
          completeBatch,
          delivery: { delivered: false, path: "none", error: lastError },
        });
        return false;
      }
      const nextAttemptAt = Date.now() + retryDelayMs;
      state = {
        status: "dispatching",
        attemptCount: state.attemptCount,
        replayCount,
        nextAttemptAt,
        batchRunIds,
        ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
        ...(state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
        ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
        lastError,
      };
      params.transitionBatch(batchRunIds, state);
      logWarn(
        `requester settle wake transport replay ${replayCount} scheduled in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
      );
      return false;
    }
    if (delivery.delivered) {
      completeRequesterSettleWakeBatch({
        runIds: batchRunIds,
        state,
        completeBatch,
        delivery,
      });
      return true;
    }
    if (
      delivery.disposition === "ambiguous" ||
      delivery.disposition === "permanent_failure" ||
      delivery.disposition === "intentional_non_delivery" ||
      delivery.reason === "requester_abandoned"
    ) {
      completeRequesterSettleWakeBatch({
        runIds: batchRunIds,
        state,
        completeBatch,
        delivery,
      });
      return false;
    }

    const attemptCount = attemptIndex + 1;
    const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[attemptIndex];
    const lastError = delivery.error ?? delivery.reason ?? "undelivered";
    if (attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS || retryDelayMs === undefined) {
      completeRequesterSettleWakeBatch({
        runIds: batchRunIds,
        state,
        completeBatch,
        delivery: { ...delivery, error: lastError },
      });
      return false;
    }
    const nextAttemptAt = Date.now() + retryDelayMs;
    params.transitionBatch(batchRunIds, {
      status: "pending",
      attemptCount,
      nextAttemptAt,
      batchRunIds,
      ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
      ...(state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
      ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
      lastError,
    });
    logWarn(
      `requester settle wake attempt ${attemptCount} failed; retrying in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
    );
    return false;
  } finally {
    activeRequesterSettleWakeBatches.delete(wakeKeyBase);
  }
}
