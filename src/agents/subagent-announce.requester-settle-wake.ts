/**
 * Durable top-level requester settle wake delivery.
 *
 * Lifecycle owns the persisted outbox state on retained subagent run rows;
 * this module selects a drained wave and delivers its synthesized wake.
 */
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { logWarn } from "../logger.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  buildChildCompletionFindings,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
} from "./subagent-announce-output.js";
import { hasUsableSessionEntry } from "./subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type { RequesterSettleWakeState, SubagentRunRecord } from "./subagent-registry.types.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-announce.registry.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

type RequesterSettleWakeDeps = {
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
};

const defaultRequesterSettleWakeDeps: RequesterSettleWakeDeps = {
  loadSubagentRegistryRuntime,
};

let requesterSettleWakeDeps: RequesterSettleWakeDeps = defaultRequesterSettleWakeDeps;

export const testing = {
  setDepsForTest(overrides?: Partial<RequesterSettleWakeDeps>) {
    requesterSettleWakeDeps = overrides
      ? { ...defaultRequesterSettleWakeDeps, ...overrides }
      : defaultRequesterSettleWakeDeps;
  },
};

type SettledRunSummary = Pick<
  SubagentRunRecord,
  "runId" | "childSessionKey" | "createdAt" | "endedAt"
>;

export type RequesterSettleWakeBatchState = Omit<RequesterSettleWakeState, "retireAfterSettle">;

const REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS = 3;
const REQUESTER_SETTLE_WAKE_MAX_AMBIGUOUS_REPLAYS = 3;
const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;
const activeRequesterSettleWakeBatches = new Set<string>();

function runIntervalsOverlap(a: SettledRunSummary, b: SettledRunSummary): boolean {
  const aEnd = typeof a.endedAt === "number" ? a.endedAt : Number.MAX_SAFE_INTEGER;
  const bEnd = typeof b.endedAt === "number" ? b.endedAt : Number.MAX_SAFE_INTEGER;
  // Fan-out membership begins at spawn, not execution admission. A queued
  // sibling can start only after another child ends and still belong to it.
  return a.createdAt <= bEnd && b.createdAt <= aEnd;
}

function buildRequesterSettleWakeMessage(params: { findings?: string }): string {
  return [
    "[Subagent Context] Every subagent spawned from this session has now settled — none are still running or awaiting completion delivery.",
    "[Subagent Context] Do not keep waiting or call sessions_yield again for this batch; no further completion events will arrive.",
    "[Subagent Context] Review the completion results and send your consolidated final answer to the user now.",
    `[Subagent Context] Reply ONLY: ${SILENT_REPLY_TOKEN} only if you already delivered the consolidated final answer for this batch.`,
    "",
    params.findings ??
      "(each child result was announced individually in earlier completion events)",
  ].join("\n");
}

function buildConnectedSettledWave(
  candidates: readonly SubagentRunRecord[],
  settledEntry: SubagentRunRecord,
): SubagentRunRecord[] {
  const unclaimed = new Set(candidates);
  const batch: SubagentRunRecord[] = [];
  const frontier: SettledRunSummary[] = [settledEntry];
  for (const entry of unclaimed) {
    if (entry.runId === settledEntry.runId) {
      unclaimed.delete(entry);
      batch.push(entry);
      frontier.push(entry);
      break;
    }
  }
  for (let pivot = frontier.pop(); pivot; pivot = frontier.pop()) {
    for (const entry of unclaimed) {
      if (runIntervalsOverlap(entry, pivot)) {
        unclaimed.delete(entry);
        batch.push(entry);
        frontier.push(entry);
      }
    }
  }
  return batch;
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
    ...(source?.lastError !== undefined ? { lastError: source.lastError } : {}),
  };
}

function deferRequesterSettleWakeBatch(params: {
  batchRunIds: readonly string[];
  state: RequesterSettleWakeBatchState;
  transitionBatch: (runIds: readonly string[], state: RequesterSettleWakeBatchState) => void;
}): void {
  params.transitionBatch(params.batchRunIds, {
    status: params.state.status,
    attemptCount: params.state.attemptCount,
    ...(params.state.replayCount !== undefined ? { replayCount: params.state.replayCount } : {}),
    nextAttemptAt: Math.max(
      params.state.nextAttemptAt ?? 0,
      Date.now() + REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[0],
    ),
    batchRunIds: [...params.batchRunIds],
    ...(params.state.lastError !== undefined ? { lastError: params.state.lastError } : {}),
  });
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
  completeBatch(runIds: readonly string[]): void;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }
  const requesterSessionKey = params.requesterSessionKey.trim();
  const initialState = params.settledEntry.requesterSettleWake;
  if (!requesterSessionKey || !initialState) {
    return false;
  }
  if (isCronSessionKey(requesterSessionKey)) {
    params.completeBatch([params.settledEntry.runId]);
    return false;
  }

  const registryRuntime = await requesterSettleWakeDeps.loadSubagentRegistryRuntime();
  const listedRuns = registryRuntime.listSubagentRunsForRequester(requesterSessionKey);
  const requesterRuns = Array.isArray(listedRuns) ? listedRuns : [];
  const currentSettledEntry =
    requesterRuns.find((entry) => entry.runId === params.settledEntry.runId) ?? params.settledEntry;
  if (!currentSettledEntry.requesterSettleWake) {
    return false;
  }
  const requesterHasUnsettledDescendants = () =>
    registryRuntime.hasDescendantRunAwaitingSettle(requesterSessionKey, currentSettledEntry.runId);

  const frozenBatchRunIds = currentSettledEntry.requesterSettleWake.batchRunIds;
  let settledBatch: SubagentRunRecord[];
  if (frozenBatchRunIds && frozenBatchRunIds.length > 0) {
    const runsById = new Map(requesterRuns.map((entry) => [entry.runId, entry]));
    settledBatch = frozenBatchRunIds
      .map((runId) => runsById.get(runId))
      .filter((entry): entry is SubagentRunRecord => Boolean(entry?.requesterSettleWake));
  } else {
    settledBatch = buildConnectedSettledWave(
      requesterRuns.filter((entry) => entry.requesterSettleWake && hasSubagentRunEnded(entry)),
      currentSettledEntry,
    );
  }
  if (settledBatch.length === 0) {
    return false;
  }

  const batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();
  if (requesterHasUnsettledDescendants()) {
    if (frozenBatchRunIds && frozenBatchRunIds.length > 0) {
      deferRequesterSettleWakeBatch({
        batchRunIds,
        state: readSharedBatchState(settledBatch),
        transitionBatch: params.transitionBatch,
      });
    }
    return false;
  }
  const requiredSettled = settledBatch.filter((entry) => entry.expectsCompletionMessage === true);
  const hasUndeliveredRequiredCompletion = requiredSettled.some(
    (entry) => entry.delivery?.status !== "delivered",
  );
  if (
    requiredSettled.length === 0 ||
    (requiredSettled.length < 2 && !hasUndeliveredRequiredCompletion) ||
    getSubagentDepthFromSessionStore(requesterSessionKey) >= 1
  ) {
    params.completeBatch(batchRunIds);
    return false;
  }

  const { entry: requesterEntry } = loadRequesterSessionEntry(requesterSessionKey);
  if (!hasUsableSessionEntry(requesterEntry)) {
    params.completeBatch(batchRunIds);
    return false;
  }

  const findings = buildChildCompletionFindings(
    dedupeLatestChildCompletionRows(
      filterCurrentDirectChildCompletionRows(settledBatch, {
        requesterSessionKey,
        getLatestSubagentRunByChildSessionKey:
          registryRuntime.getLatestSubagentRunByChildSessionKey,
      }),
    ),
  );
  const wakeMessage = buildRequesterSettleWakeMessage({ findings });
  const requesterSessionOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const directOrigin = resolveAnnounceOrigin(requesterEntry, requesterSessionOrigin);
  const wakeKeyBase = `requester-settle:${requesterSessionKey}:${batchRunIds.join(",")}`;
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
        params.completeBatch(batchRunIds);
        return false;
      }
      attemptIndex = state.attemptCount;
      state = {
        status: "dispatching",
        attemptCount: state.attemptCount + 1,
        batchRunIds,
      };
      params.transitionBatch(batchRunIds, state);
    }

    let delivery: Awaited<ReturnType<typeof deliverSubagentAnnouncement>>;
    try {
      delivery = await deliverSubagentAnnouncement({
        requesterSessionKey,
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
        directIdempotencyKey: buildAnnounceIdempotencyKey(
          attemptIndex === 0 ? wakeKeyBase : `${wakeKeyBase}:retry-${attemptIndex}`,
        ),
        signal: params.signal,
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
        params.completeBatch(batchRunIds);
        return false;
      }
      const nextAttemptAt = Date.now() + retryDelayMs;
      state = {
        status: "dispatching",
        attemptCount: state.attemptCount,
        replayCount,
        nextAttemptAt,
        batchRunIds,
        lastError,
      };
      params.transitionBatch(batchRunIds, state);
      logWarn(
        `requester settle wake transport replay ${replayCount} scheduled in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
      );
      return false;
    }
    if (delivery.delivered) {
      params.completeBatch(batchRunIds);
      return true;
    }
    if (delivery.terminal === true || delivery.reason === "requester_abandoned") {
      params.completeBatch(batchRunIds);
      return false;
    }

    const attemptCount = attemptIndex + 1;
    const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[attemptIndex];
    if (attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS || retryDelayMs === undefined) {
      params.completeBatch(batchRunIds);
      return false;
    }
    const lastError = delivery.error ?? delivery.reason ?? "undelivered";
    const nextAttemptAt = Date.now() + retryDelayMs;
    params.transitionBatch(batchRunIds, {
      status: "pending",
      attemptCount,
      nextAttemptAt,
      batchRunIds,
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
