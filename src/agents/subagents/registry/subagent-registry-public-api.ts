import {
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "../../agent-steering-queue.js";
import { isSameAcceptedRunTermination } from "./subagent-accepted-run-termination.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import {
  countActiveRunsForSessionFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
} from "./subagent-registry-queries.js";
import { markRequesterTurnYieldedInRuns } from "./subagent-registry-requester-yield.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord, SwarmStructuredOutputState } from "./subagent-registry.types.js";

export function createSubagentRegistryPublicApi(config: {
  runs: Map<string, SubagentRunRecord>;
  persist: (...runIds: string[]) => void;
  persistOrThrow: (...runIds: string[]) => void;
  restoreOnce: () => void;
  startAnnounceCleanup: (runId: string, entry: SubagentRunRecord) => boolean;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
}) {
  const { runs, persist, persistOrThrow, restoreOnce, startAnnounceCleanup, settleRequesterTurn } =
    config;
  const readRuns = () => getSubagentRunsSnapshotForRead(runs);
  const findRunById = (records: Map<string, SubagentRunRecord>, runId: string) =>
    records.get(runId) ?? [...records.values()].find((entry) => entry.swarmRunId === runId);

  function leasePendingAgentSteeringItems(params: {
    requesterSessionKey: string;
    leaseId: string;
    now?: number;
  }) {
    restoreOnce();
    const leased = leasePendingAgentSteeringItemsFromSubagentRuns({ ...params, runs });
    if (leased) {
      persist(...leased.runIds);
    }
    return leased;
  }

  function ackPendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    now?: number;
  }): number {
    const updated = ackLeasedAgentSteeringItemsFromSubagentRuns({ ...params, runs });
    if (updated > 0) {
      persist(...params.runIds);
      for (const runId of params.runIds) {
        const entry = runs.get(runId);
        if (!entry || typeof entry.cleanupCompletedAt === "number") {
          continue;
        }
        entry.cleanupHandled = false;
        startAnnounceCleanup(runId, entry);
      }
    }
    return updated;
  }

  function releasePendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    error?: string;
  }): number {
    const updated = releaseLeasedAgentSteeringItemsFromSubagentRuns({ ...params, runs });
    if (updated > 0) {
      persist(...params.runIds);
    }
    return updated;
  }

  function getSubagentRunByRunId(runId: string): SubagentRunRecord | undefined {
    return findRunById(readRuns(), runId.trim());
  }

  function getSubagentRunsByRunIds(runIds: readonly string[]): {
    entries: Map<string, SubagentRunRecord>;
  } {
    const byId = new Map<string, SubagentRunRecord>();
    for (const entry of readRuns().values()) {
      byId.set(entry.runId, entry);
      if (entry.swarmRunId) {
        byId.set(entry.swarmRunId, entry);
      }
    }
    return {
      entries: new Map(
        runIds.flatMap((runId) => {
          const entry = byId.get(runId.trim());
          return entry ? [[runId, entry] as const] : [];
        }),
      ),
    };
  }

  function completeFailedLaunchCleanup(runId: string): void {
    const entry = findRunById(runs, runId.trim());
    if (!entry?.launchCleanupPending || entry.acceptedRunTermination) {
      return;
    }
    entry.launchCleanupPending = undefined;
    entry.launchCleanupSessionIdentity = undefined;
    entry.launchCleanupSessionOutcome = undefined;
    entry.cleanupCompletedAt = Date.now();
    entry.contextEngineCleanupCompletedAt ??= entry.cleanupCompletedAt;
    persist(entry.runId);
  }

  function completeFailedLaunchContextEngineCleanup(runId: string): void {
    const entry = findRunById(runs, runId.trim());
    if (!entry?.launchCleanupPending || entry.execution.status !== "terminal") {
      return;
    }
    entry.contextEngineCleanupCompletedAt ??= Date.now();
    persist(entry.runId);
  }

  function recordAcceptedRunTermination(
    runId: string,
    termination: NonNullable<SubagentRunRecord["acceptedRunTermination"]>,
  ): void {
    const entry = findRunById(runs, runId.trim());
    if (!entry) {
      throw new Error("accepted-run termination owner is unavailable");
    }
    const previous = entry.acceptedRunTermination;
    if (previous) {
      if (isSameAcceptedRunTermination(previous, termination) && previous.phase === "attempted") {
        return;
      }
      throw new Error("accepted-run termination owner is already occupied");
    }
    entry.acceptedRunTermination = termination;
    try {
      persistOrThrow(entry.runId);
    } catch (error) {
      entry.acceptedRunTermination = previous;
      throw error;
    }
  }

  function completeAcceptedRunTermination(
    runId: string,
    expected: NonNullable<SubagentRunRecord["acceptedRunTermination"]>,
    sessionCleanupOutcome?: "deleted" | "changed",
  ): boolean {
    const entry = findRunById(runs, runId.trim());
    const current = entry?.acceptedRunTermination;
    if (!entry || !isSameAcceptedRunTermination(current, expected)) {
      return false;
    }
    const previousSessionCleanupOutcome = entry.launchCleanupSessionOutcome;
    entry.acceptedRunTermination = undefined;
    if (expected.kind === "launch" && sessionCleanupOutcome) {
      entry.launchCleanupSessionOutcome = sessionCleanupOutcome;
    }
    try {
      persistOrThrow(entry.runId);
    } catch (error) {
      entry.acceptedRunTermination = current;
      entry.launchCleanupSessionOutcome = previousSessionCleanupOutcome;
      throw error;
    }
    return true;
  }

  function markAcceptedRunTerminationPending(
    runId: string,
    expected: NonNullable<SubagentRunRecord["acceptedRunTermination"]>,
  ): boolean {
    const entry = findRunById(runs, runId.trim());
    const current = entry?.acceptedRunTermination;
    if (!entry || !isSameAcceptedRunTermination(current, expected)) {
      return false;
    }
    if (current.phase === "termination-pending") {
      return true;
    }
    entry.acceptedRunTermination = { ...current, phase: "termination-pending" };
    // The prior durable `attempted` owner becomes stale after restart. Keeping
    // the in-memory pending phase on a transient store failure lets this
    // process hand cleanup to the sweeper immediately without losing closure.
    persist(entry.runId);
    return true;
  }

  function recordSwarmStructuredOutput(
    identity: { runId?: string; childSessionKey?: string },
    state: SwarmStructuredOutputState,
  ): void {
    const runId = identity.runId?.trim();
    const childSessionKey = identity.childSessionKey?.trim();
    const entry =
      (runId ? findRunById(runs, runId) : undefined) ??
      (childSessionKey
        ? getLatestSubagentRunByChildSessionKeyFromRuns(
            getSubagentRunsForChildSession(childSessionKey),
            childSessionKey,
          )
        : undefined);
    if (!entry?.collect || entry.collectorCompletion) {
      throw new Error("collector run is unavailable");
    }
    const previous = entry.structuredOutput;
    entry.structuredOutput = structuredClone(state);
    try {
      persistOrThrow(entry.runId);
    } catch (error) {
      entry.structuredOutput = previous;
      throw error;
    }
  }

  function listSwarmRunsForGroup(
    groupId: string,
    requesterSessionKey?: string,
  ): SubagentRunRecord[] {
    const key = groupId.trim();
    const requesterKey = requesterSessionKey?.trim();
    return [...readRuns().values()].filter(
      (entry) =>
        entry.collect === true &&
        entry.groupId === key &&
        (!requesterKey ||
          (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey),
    );
  }

  /** Resolve a collector reserved by a replay-safe host bridge request. */
  function getSwarmRunByLaunchReplayKey(
    replayKey: string,
    requesterSessionKey?: string,
  ): SubagentRunRecord | undefined {
    const key = replayKey.trim();
    const requesterKey = requesterSessionKey?.trim();
    if (!key) {
      return undefined;
    }
    return [...readRuns().values()].find(
      (entry) =>
        entry.collect === true &&
        entry.swarmLaunchReplayKey === key &&
        (!requesterKey ||
          (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey),
    );
  }

  function countActiveRunsForSession(
    requesterSessionKey: string,
    options?: { collect?: boolean },
  ): number {
    return countActiveRunsForSessionFromRuns(readRuns(), requesterSessionKey, options);
  }

  /** Records sessions_yield before the active requester run is aborted. */
  function markRequesterTurnYielded(params: {
    requesterSessionKey: string;
    requesterTurnRunId: string;
  }): number {
    restoreOnce();
    return markRequesterTurnYieldedInRuns({
      ...params,
      runs,
      persistOrThrow,
    });
  }

  return {
    leasePendingAgentSteeringItems,
    ackPendingAgentSteeringItems,
    releasePendingAgentSteeringItems,
    getSubagentRunByRunId,
    getSubagentRunsByRunIds,
    completeFailedLaunchCleanup,
    completeFailedLaunchContextEngineCleanup,
    recordAcceptedRunTermination,
    markAcceptedRunTerminationPending,
    completeAcceptedRunTermination,
    recordSwarmStructuredOutput,
    listSwarmRunsForGroup,
    getSwarmRunByLaunchReplayKey,
    countActiveRunsForSession,
    settleRequesterAfterSessionSpawns: settleRequesterTurn,
    markRequesterTurnYielded,
  };
}
