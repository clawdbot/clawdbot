/** Settles durable child ownership when the spawning requester turn ends. */
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Persists explicit yield intent before the requester run is aborted. */
export function markRequesterTurnYieldedInRuns(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
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
      (!params.requesterAgentId || entry.requesterAgentId === params.requesterAgentId) &&
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
  requesterAgentId?: string;
  requesterTurnRunId: string;
  requesterYielded: boolean;
  acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(...runIds: string[]): void;
  schedule(runId: string, entry: SubagentRunRecord): void;
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
      (!params.requesterAgentId || entry.requesterAgentId === params.requesterAgentId) &&
      entry.requesterTurnRunId === requesterTurnRunId &&
      entry.expectsCompletionMessage === true,
  );
  const requiredRunIds = new Set(
    params.acceptedSessionSpawns
      .filter((spawn) => spawn.expectsCompletionMessage === true)
      .map((spawn) => spawn.runId),
  );
  for (const entry of entries) {
    const taskRunId = entry.taskRunId ?? entry.runId;
    const spawn = spawnsByRunId.get(taskRunId);
    if (
      !spawn ||
      entry.childSessionKey !== spawn.childSessionKey ||
      (params.requesterYielded && entry.requesterTurnYielded !== true)
    ) {
      return false;
    }
    requiredRunIds.delete(taskRunId);
  }
  // Accepted completion receipts outlive registry rows. A surviving subset
  // cannot attest that the whole requester obligation transferred to a wake.
  if (requiredRunIds.size > 0) {
    return false;
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
  const requesterAlreadyDeliveredFinal =
    params.requesterYielded &&
    entries.every(
      (entry) =>
        entry.execution.status === "terminal" &&
        typeof entry.execution.endedAt === "number" &&
        entry.delivery?.status === "delivered" &&
        typeof entry.cleanupCompletedAt === "number",
    ) &&
    entries.some((entry) => {
      const receipt = entry.delivery?.requesterVisibleFinal;
      return (
        receipt?.requesterTurnRunId === requesterTurnRunId &&
        receipt.batchRunIds.length === batchRunIds.length &&
        receipt.batchRunIds.every((runId, index) => runId === batchRunIds[index])
      );
    });
  let rearmGeneration: number | undefined;
  if (params.requesterYielded && !requesterAlreadyDeliveredFinal) {
    rearmGeneration =
      Math.max(0, ...entries.map((entry) => entry.requesterSettleWake?.rearmGeneration ?? 0)) + 1;
    for (const entry of entries) {
      const existing = entry.requesterSettleWake;
      const completionEnded = typeof entry.execution.endedAt === "number";
      // An in-progress delivery may already target the requester run being aborted.
      // Re-arm it like a delivered result so that completion cannot die with that turn.
      const completionMayBeAttachedToYieldedTurn = completionEnded;
      if (completionEnded && entry.delivery?.status !== "delivered") {
        // The persisted yielded batch now owns terminal delivery. Mark the old
        // per-child attempt terminal so it cannot keep the batch unsettled.
        entry.delivery = {
          ...(entry.delivery ?? { status: "pending" }),
          disposition: "intentional_non_delivery",
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
      if (entry.delivery) {
        delete entry.delivery.requesterVisibleFinal;
      }
      if (requesterAlreadyDeliveredFinal) {
        // The receipt proves this yielded batch already reached requester-visible delivery.
        // Clear its provisional wake so settling the parent cannot replay the batch.
        entry.requesterSettleWake = undefined;
      }
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

  if (
    rearmGeneration !== undefined &&
    entries.every((entry) => typeof entry.execution.endedAt === "number")
  ) {
    // Active children keep the frozen batch; their normal completion owner schedules it.
    params.schedule(firstEntry.runId, firstEntry);
  } else if (
    !params.requesterYielded &&
    entries.every((entry) => typeof entry.execution.endedAt === "number")
  ) {
    // A terminal child cannot wake while its requester still owns the turn.
    // Once a normal parent response settles, resume its original per-child delivery.
    for (const entry of entries) {
      if (params.runs.has(entry.runId)) {
        params.schedule(entry.runId, entry);
      }
    }
  }
  return true;
}
