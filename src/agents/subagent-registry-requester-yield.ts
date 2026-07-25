/** Settles durable child ownership when the spawning requester turn ends. */
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Persists explicit yield intent before the requester run is aborted. */
export function markRequesterTurnYieldedInRuns(params: {
  requesterSessionKey: string;
  requesterTurnRunId: string;
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(): void;
}): number {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId.trim();
  if (!requesterSessionKey || !requesterTurnRunId) {
    return 0;
  }
  const entries = [...params.runs.values()].filter(
    (entry) =>
      entry.requesterSessionKey === requesterSessionKey &&
      entry.requesterTurnRunId === requesterTurnRunId,
  );
  if (entries.every((entry) => entry.requesterTurnYielded === true)) {
    return entries.length;
  }
  const previous = entries.map((entry) => entry.requesterTurnYielded);
  for (const entry of entries) {
    entry.requesterTurnYielded = true;
  }
  try {
    params.persistOrThrow();
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
  persistOrThrow(): void;
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

  // Registry markers select completion-producing children. Accepted inline or
  // otherwise non-completion spawns are intentionally outside this batch.
  const entries = [...params.runs.values()].filter(
    (entry) =>
      entry.requesterSessionKey === requesterSessionKey &&
      entry.requesterTurnRunId === requesterTurnRunId,
  );
  for (const entry of entries) {
    const spawn = spawnsByRunId.get(entry.runId);
    if (
      !spawn ||
      entry.expectsCompletionMessage !== true ||
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
    requesterSettleWake: structuredClone(entry.requesterSettleWake),
    requesterTurnRunId: entry.requesterTurnRunId,
    requesterTurnYielded: entry.requesterTurnYielded,
    retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
  }));
  let rearmGeneration: number | undefined;
  if (params.requesterYielded) {
    rearmGeneration =
      Math.max(0, ...entries.map((entry) => entry.requesterSettleWake?.rearmGeneration ?? 0)) + 1;
    for (const entry of entries) {
      const existing = entry.requesterSettleWake;
      // An in-progress delivery may already target the requester run being aborted.
      // Re-arm it like a delivered result so that completion cannot die with that turn.
      const completionMayBeAttachedToYieldedTurn =
        typeof entry.endedAt === "number" &&
        (entry.delivery?.status === "delivered" || entry.delivery?.status === "in_progress");
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
    params.persistOrThrow();
  } catch (error) {
    entries.forEach((entry, index) => {
      const previous = previousStates[index];
      params.runs.set(entry.runId, entry);
      entry.requesterSettleWake = previous?.requesterSettleWake;
      entry.requesterTurnRunId = previous?.requesterTurnRunId;
      entry.requesterTurnYielded = previous?.requesterTurnYielded;
      entry.retireAfterRequesterTurn = previous?.retireAfterRequesterTurn;
    });
    throw error;
  }

  if (
    rearmGeneration !== undefined &&
    entries.every(
      (entry) => typeof entry.endedAt === "number" && entry.delivery?.status === "delivered",
    )
  ) {
    // Active children keep the frozen batch but let their normal cleanup owner schedule it.
    params.schedule(firstEntry.runId, firstEntry);
  }
  return true;
}
