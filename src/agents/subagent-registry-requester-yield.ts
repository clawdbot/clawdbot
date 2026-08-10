/** Settles durable child ownership when the spawning requester turn ends. */
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Persists explicit yield intent before the requester run is aborted. */
export function markRequesterTurnYieldedInRuns(params: {
  requesterSessionKey: string;
  requesterTurnRunId: string;
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(...runIds: string[]): void;
}): number {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId.trim();
  if (!requesterSessionKey || !requesterTurnRunId) {
    return 0;
  }
  const entries = [...params.runs.values()].filter(
    (entry) =>
      entry.requesterSessionKey === requesterSessionKey &&
      entry.requesterTurnRunId === requesterTurnRunId &&
      entry.expectsCompletionMessage === true,
  );
  if (entries.every((entry) => entry.requesterTurnYielded === true)) {
    return entries.length;
  }
  const previous = entries.map((entry) => entry.requesterTurnYielded);
  for (const entry of entries) {
    entry.requesterTurnYielded = true;
  }
  try {
    params.persistOrThrow(...entries.map((entry) => entry.runId));
  } catch (error) {
    entries.forEach((entry, index) => {
      entry.requesterTurnYielded = previous[index];
    });
    throw error;
  }
  return entries.length;
}

export function settleRequesterTurnAfterSessionSpawns(params: {
  requesterSessionKey: string;
  requesterTurnRunId: string;
  requesterYielded: boolean;
  acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(...runIds: string[]): void;
  schedule(runId: string, entry: SubagentRunRecord): void;
  markTaskDeliveryPending(entry: SubagentRunRecord): boolean;
}): boolean {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId.trim();
  const spawnsByRunId = new Map(
    params.acceptedSessionSpawns.map((spawn) => [spawn.runId, spawn] as const),
  );
  if (!requesterSessionKey || !requesterTurnRunId || spawnsByRunId.size === 0) {
    return false;
  }

  // Completion rows keep their original task owner across steer; inline or
  // non-completion spawns are intentionally outside this batch.
  const entries = [...params.runs.values()].filter(
    (entry) =>
      entry.requesterSessionKey === requesterSessionKey &&
      entry.requesterTurnRunId === requesterTurnRunId &&
      entry.expectsCompletionMessage === true,
  );
  for (const entry of entries) {
    const spawn = spawnsByRunId.get(entry.taskRunId ?? entry.runId);
    if (
      !spawn ||
      entry.childSessionKey !== spawn.childSessionKey ||
      (params.requesterYielded && entry.requesterTurnYielded !== true)
    ) {
      return false;
    }
  }

  const firstEntry = entries[0];
  if (!firstEntry) {
    return false;
  }
  const batchRunIds = entries.map((entry) => entry.runId).toSorted();
  const previousStates = entries.map((entry) => ({
    delivery: structuredClone(entry.delivery),
    requesterSettleWake: structuredClone(entry.requesterSettleWake),
    requesterTurnRunId: entry.requesterTurnRunId,
    requesterTurnYielded: entry.requesterTurnYielded,
    retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
  }));
  let rearmGeneration: number | undefined;
  const requesterSettlementOwnsDelivery =
    params.requesterYielded && getSubagentDepthFromSessionStore(requesterSessionKey) < 1;
  if (params.requesterYielded) {
    rearmGeneration =
      Math.max(0, ...entries.map((entry) => entry.requesterSettleWake?.rearmGeneration ?? 0)) + 1;
    for (const entry of entries) {
      const existing = entry.requesterSettleWake;
      const completionEnded = typeof entry.execution.endedAt === "number";
      // An in-progress delivery may already target the requester run being aborted.
      // Re-arm it like a delivered result so that completion cannot die with that turn.
      const completionMayBeAttachedToYieldedTurn = completionEnded;
      if (requesterSettlementOwnsDelivery) {
        // The top-level requester-settle outbox now owns terminal delivery. Any
        // earlier credit belonged to the requester turn that just yielded, not
        // to its eventual visible-final-or-quiet settlement. Nested requesters
        // resume through the descendant wake/replacement-run lifecycle instead.
        entry.delivery = {
          ...(entry.delivery ?? { status: "pending" }),
          status: "pending",
          deliveredAt: undefined,
          announcedAt: undefined,
          disposition: "intentional_non_delivery",
          lastError: undefined,
          lastDropReason: "waiting_for_requester_turn",
        };
      }
      entry.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds,
        requesterYieldBatch: true,
        ...(completionMayBeAttachedToYieldedTurn ? { afterRequesterYield: true } : {}),
        rearmGeneration,
        ...(existing?.retireAfterSettle === true || entry.retireAfterRequesterTurn === true
          ? { retireAfterSettle: true }
          : {}),
      };
      entry.requesterTurnRunId = undefined;
      entry.requesterTurnYielded = undefined;
      entry.retireAfterRequesterTurn = undefined;
    }
  } else {
    for (const entry of entries) {
      entry.requesterTurnRunId = undefined;
      entry.requesterTurnYielded = undefined;
      if (entry.retireAfterRequesterTurn === true) {
        if (entry.requesterSettleWake) {
          entry.requesterSettleWake.retireAfterSettle = true;
          entry.retireAfterRequesterTurn = undefined;
        } else {
          params.runs.delete(entry.runId);
        }
      }
    }
  }
  try {
    params.persistOrThrow(...entries.map((entry) => entry.runId));
  } catch (error) {
    entries.forEach((entry, index) => {
      const previous = previousStates[index];
      params.runs.set(entry.runId, entry);
      entry.delivery = previous?.delivery;
      entry.requesterSettleWake = previous?.requesterSettleWake;
      entry.requesterTurnRunId = previous?.requesterTurnRunId;
      entry.requesterTurnYielded = previous?.requesterTurnYielded;
      entry.retireAfterRequesterTurn = previous?.retireAfterRequesterTurn;
    });
    throw error;
  }

  if (requesterSettlementOwnsDelivery) {
    // The durable wake is now the recovery owner. Best-effort the matching
    // Task projection immediately; the wake lifecycle repeats this fence
    // before requester dispatch, so a crash or transient projection failure
    // cannot settle the parent while child delivery still appears credited.
    for (const entry of entries) {
      params.markTaskDeliveryPending(entry);
    }
  }

  if (
    rearmGeneration !== undefined &&
    entries.every((entry) => typeof entry.execution.endedAt === "number")
  ) {
    // Active children keep the frozen batch; their normal completion owner schedules it.
    params.schedule(firstEntry.runId, firstEntry);
  }
  return true;
}
