/**
 * Durable top-level requester settle wake delivery.
 *
 * Lifecycle owns the persisted outbox state on retained subagent run rows;
 * this module selects a drained wave and delivers its synthesized wake.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
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
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  countActiveDescendantRuns,
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

type RequesterSettleWakeBatchCallbacks = {
  transitionBatch: (
    batch: readonly SubagentRunRecord[],
    state: RequesterSettleWakeBatchState,
  ) => void;
  completeBatch: (
    batch: readonly SubagentRunRecord[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
  ) => void;
};

const REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS = 3;
const REQUESTER_SETTLE_WAKE_MAX_AMBIGUOUS_REPLAYS = 3;
const REQUESTER_SETTLE_WAKE_MAX_DEFERRALS = 10;
const REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS = 1_024;
const ROUTE_NOTICE_TRUNCATION = "\n[model-route changes truncated]";
const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;
const activeRequesterSettleWakeBatches = new Map<string, () => boolean>();

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

/**
 * Wakes a registry-less top-level requester once its last spawned child
 * reaches terminal settle. Durable state transitions happen synchronously
 * through lifecycle-owned callbacks before and after every async delivery.
 */
export async function maybeWakeRequesterAfterAllChildrenSettled(
  params: RequesterSettleWakeBatchCallbacks & {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    settledEntry: SubagentRunRecord;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }
  const { completeBatch } = params;
  const requesterSessionKey = params.requesterSessionKey.trim();
  const cfg = getRuntimeConfig();
  const requesterAgentId = resolveSubagentRequesterAgentId(cfg, params.settledEntry);
  const initialState = params.settledEntry.requesterSettleWake;
  if (!requesterSessionKey || !initialState) {
    return false;
  }
  const admittedRearmGeneration = initialState.rearmGeneration;
  if (isCronSessionKey(requesterSessionKey)) {
    completeBatch([params.settledEntry], initialState.rearmGeneration);
    return false;
  }

  const listedRuns = listSubagentRunsForRequester(requesterSessionKey, {
    requesterAgentId,
  });
  const requesterRuns = Array.isArray(listedRuns) ? listedRuns : [];
  const currentSettledEntry = requesterRuns.find(
    (entry) => entry.runId === params.settledEntry.runId,
  );
  const currentState = currentSettledEntry?.requesterSettleWake;
  // A requester yield may re-arm this row while runtime loading is in flight.
  // Only the admitted generation may inspect descendants or mutate its batch.
  if (
    currentSettledEntry !== params.settledEntry ||
    !currentState ||
    currentState.rearmGeneration !== admittedRearmGeneration
  ) {
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
    // An unfrozen wave cannot absorb a different requester-yield generation.
    // Its frozen cohort still owns its deadline, retry budget, and visible final.
    settledBatch = buildConnectedSettledWave(
      requesterRuns.filter(
        (entry) =>
          entry.requesterSettleWake &&
          entry.requesterSettleWake.rearmGeneration === currentRearmGeneration &&
          entry.execution.status !== "running" &&
          hasSubagentRunEnded(entry),
      ),
      currentSettledEntry,
    );
  }
  if (settledBatch.length === 0) {
    return false;
  }

  const resolveGatewayContext = getSharedGatewayContextResolver(settledBatch);
  const hadGatewayContext = Boolean(resolveGatewayContext?.());
  // Runtime loading may outlive the Gateway. Unavailable ownership spends no delivery budget.
  if (resolveGatewayContext && !hadGatewayContext) {
    return false;
  }
  const batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();
  const selectedState = readSharedBatchState(settledBatch);
  function deferBatch(state: RequesterSettleWakeBatchState): void {
    const countTowardsLimit =
      countActiveDescendantRuns(requesterSessionKey, requesterAgentId) === 0;
    const now = Date.now();
    if ((state.nextAttemptAt ?? 0) > now) {
      return;
    }
    // Live descendants are valid overlapping work, not a stale settle loop.
    // Reset their stale-deferral budget so long-running waves cannot terminalize
    // an already completed sibling before the requester can receive it.
    const deferralCount = countTowardsLimit ? (state.deferralCount ?? 0) + 1 : 0;
    if (countTowardsLimit && deferralCount >= REQUESTER_SETTLE_WAKE_MAX_DEFERRALS) {
      completeBatch(settledBatch, state.rearmGeneration, {
        delivered: false,
        path: "none",
        error: "requester settle wake deferred too many times",
      });
      return;
    }
    params.transitionBatch(settledBatch, {
      status: state.status,
      attemptCount: state.attemptCount,
      ...(state.replayCount !== undefined ? { replayCount: state.replayCount } : {}),
      nextAttemptAt: Math.max(
        state.nextAttemptAt ?? 0,
        now + REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[0],
      ),
      batchRunIds: [...batchRunIds],
      ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
      ...(state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
      ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
      ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
      deferralCount,
    });
  }
  if (hasUnsettledDescendants) {
    if (frozenBatchRunIds && frozenBatchRunIds.length > 0) {
      deferBatch(selectedState);
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
    completeBatch(settledBatch, selectedState.rearmGeneration);
    return false;
  }

  const { entry: requesterEntry } = loadRequesterSessionEntry(
    requesterSessionKey,
    requesterAgentId,
  );
  if (!hasUsableSessionEntry(requesterEntry)) {
    completeBatch(settledBatch, selectedState.rearmGeneration, {
      delivered: false,
      path: "none",
      error: "requester session unavailable",
    });
    return false;
  }

  const completionRows = dedupeLatestChildCompletionRows(
    filterCurrentDirectChildCompletionRows(settledBatch, {
      requesterSessionKey,
      requesterAgentId,
      getLatestSubagentRunByChildSessionKey,
    }),
  );
  const findings = buildChildCompletionFindings(completionRows);
  const requesterSessionOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const directOrigin = resolveAnnounceOrigin(requesterEntry, requesterSessionOrigin);
  // The scheduling row need not be the rerouted child. Keep every current
  // child's producer-owned notice, with stable bytes and one batch-wide cap.
  const routeNotices = [
    ...new Set(
      completionRows.flatMap(({ completion }) => {
        const reply = completion?.terminalReply;
        return reply?.disposition === "visible" && reply.modelRouteChange
          ? [reply.modelRouteChange]
          : [];
      }),
    ),
  ]
    .toSorted()
    .join("\n");
  const modelRouteChange =
    routeNotices.length > REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS
      ? `${truncateUtf16Safe(routeNotices, REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS - ROUTE_NOTICE_TRUNCATION.length)}${ROUTE_NOTICE_TRUNCATION}`
      : routeNotices;
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
  const activeBatchIsClosed = activeRequesterSettleWakeBatches.get(wakeKeyBase);
  if (activeBatchIsClosed && !activeBatchIsClosed()) {
    return false;
  }
  // A matching key or fresh row cannot supersede live or unproven authority.
  const isGatewayClosed = () => {
    try {
      return hadGatewayContext && !resolveGatewayContext?.();
    } catch {
      // An incompatible captured batch cannot keep a fresh owner's claim blocked.
      return hadGatewayContext;
    }
  };
  activeRequesterSettleWakeBatches.set(wakeKeyBase, isGatewayClosed);

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
      deferBatch(state);
      return false;
    }

    let attemptIndex: number;
    if (state.status === "dispatching") {
      // Ambiguous delivery reuses its attempt key. Completed-turn RPC replay
      // is Gateway-local; the key alone is not a cross-restart delivery receipt.
      attemptIndex = Math.max(0, state.attemptCount - 1);
    } else {
      if (state.attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS) {
        completeBatch(settledBatch, state.rearmGeneration, {
          delivered: false,
          path: "none",
          error: state.lastError ?? "requester settle wake attempts exhausted",
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
      params.transitionBatch(settledBatch, state);
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
        resolveGatewayContext,
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
        completeBatch(settledBatch, state.rearmGeneration, {
          delivered: false,
          path: "none",
          error: lastError,
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
      params.transitionBatch(settledBatch, state);
      logWarn(
        `requester settle wake transport replay ${replayCount} scheduled in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
      );
      return false;
    }
    if (delivery.delivered) {
      completeBatch(settledBatch, state.rearmGeneration, delivery);
      return true;
    }
    if (
      delivery.disposition === "ambiguous" ||
      delivery.disposition === "permanent_failure" ||
      delivery.disposition === "intentional_non_delivery" ||
      delivery.reason === "requester_abandoned"
    ) {
      completeBatch(settledBatch, state.rearmGeneration, delivery);
      return false;
    }

    const attemptCount = attemptIndex + 1;
    const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[attemptIndex];
    const lastError = delivery.error ?? delivery.reason ?? "undelivered";
    if (attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS || retryDelayMs === undefined) {
      completeBatch(settledBatch, state.rearmGeneration, { ...delivery, error: lastError });
      return false;
    }
    const nextAttemptAt = Date.now() + retryDelayMs;
    params.transitionBatch(settledBatch, {
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
    if (activeRequesterSettleWakeBatches.get(wakeKeyBase) === isGatewayClosed) {
      activeRequesterSettleWakeBatches.delete(wakeKeyBase);
    }
  }
}
