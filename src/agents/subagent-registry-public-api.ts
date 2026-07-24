import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import {
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "./agent-steering-queue.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import type { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import {
  countActiveDescendantRunsFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForControllerFromRuns,
} from "./subagent-registry-queries.js";
import { markRequesterTurnYieldedInRuns } from "./subagent-registry-requester-yield.js";
import type { SubagentRunRecord, SwarmStructuredOutputState } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

export function createSubagentRegistryPublicApi(config: {
  runs: Map<string, SubagentRunRecord>;
  deps: () => SubagentRegistryDeps;
  persist: () => void;
  persistOrThrow: () => void;
  restoreOnce: () => void;
  startAnnounceCleanup: (runId: string, entry: SubagentRunRecord) => boolean;
  settleRequesterTurn: ReturnType<
    typeof createSubagentRegistryLifecycleController
  >["settleRequesterTurnAfterSessionSpawns"];
}) {
  const {
    runs,
    deps,
    persist,
    persistOrThrow,
    restoreOnce,
    startAnnounceCleanup,
    settleRequesterTurn,
  } = config;

  function leasePendingAgentSteeringItems(params: {
    requesterSessionKey: string;
    leaseId: string;
    now?: number;
  }) {
    restoreOnce();
    const leased = leasePendingAgentSteeringItemsFromSubagentRuns({
      runs,
      requesterSessionKey: params.requesterSessionKey,
      leaseId: params.leaseId,
      now: params.now,
    });
    if (leased) {
      persist();
    }
    return leased;
  }

  function ackPendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    now?: number;
  }): number {
    const updated = ackLeasedAgentSteeringItemsFromSubagentRuns({
      runs,
      runIds: params.runIds,
      leaseId: params.leaseId,
      now: params.now,
    });
    if (updated > 0) {
      persist();
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
    const updated = releaseLeasedAgentSteeringItemsFromSubagentRuns({
      runs,
      runIds: params.runIds,
      leaseId: params.leaseId,
      error: params.error,
    });
    if (updated > 0) {
      persist();
    }
    return updated;
  }

  function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
    return listRunsForControllerFromRuns(
      deps().getSubagentRunsSnapshotForController(runs, controllerSessionKey),
      controllerSessionKey,
    );
  }

  function getSubagentRunByRunId(runId: string): SubagentRunRecord | undefined {
    const key = runId.trim();
    const snapshot = deps().getSubagentRunsSnapshotForRead(runs);
    return snapshot.get(key) ?? [...snapshot.values()].find((entry) => entry.swarmRunId === key);
  }

  function getSubagentRunsByRunIds(runIds: readonly string[]): {
    entries: Map<string, SubagentRunRecord>;
  } {
    const snapshot = deps().getSubagentRunsSnapshotForRead(runs);
    const byId = new Map<string, SubagentRunRecord>();
    for (const entry of snapshot.values()) {
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

  function completeCollectorLaunchCleanup(runId: string): void {
    const key = runId.trim();
    const entry =
      runs.get(key) ?? [...runs.values()].find((candidate) => candidate.swarmRunId === key);
    if (!entry?.collectorLaunchCleanupPending) {
      return;
    }
    entry.collectorLaunchCleanupPending = false;
    entry.cleanupCompletedAt = Date.now();
    entry.contextEngineCleanupCompletedAt ??= entry.cleanupCompletedAt;
    persist();
  }

  function recordSwarmStructuredOutput(
    identity: { runId?: string; childSessionKey?: string },
    state: SwarmStructuredOutputState,
  ): void {
    const runId = identity.runId?.trim();
    const childSessionKey = identity.childSessionKey?.trim();
    const entry =
      (runId
        ? (runs.get(runId) ??
          [...runs.values()].find((candidate) => candidate.swarmRunId === runId))
        : undefined) ??
      (childSessionKey
        ? [...runs.values()]
            .filter((candidate) => candidate.childSessionKey === childSessionKey)
            .toSorted((left, right) => (right.generation ?? 0) - (left.generation ?? 0))[0]
        : undefined);
    if (!entry?.collect || entry.collectorCompletion) {
      throw new Error("collector run is unavailable");
    }
    const previous = entry.structuredOutput;
    entry.structuredOutput = structuredClone(state);
    try {
      persistOrThrow();
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
    return [...deps().getSubagentRunsSnapshotForRead(runs).values()].filter(
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
    return [...deps().getSubagentRunsSnapshotForRead(runs).values()].find(
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
    return countActiveRunsForSessionFromRuns(
      deps().getSubagentRunsSnapshotForRead(runs),
      requesterSessionKey,
      options,
    );
  }

  function countActiveDescendantRuns(rootSessionKey: string): number {
    return countActiveDescendantRunsFromRuns(
      deps().getSubagentRunsSnapshotForRead(runs),
      rootSessionKey,
    );
  }

  function countPendingDescendantRuns(rootSessionKey: string): number {
    return countPendingDescendantRunsFromRuns(
      deps().getSubagentRunsSnapshotForRead(runs),
      rootSessionKey,
    );
  }

  function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
    return listDescendantRunsForRequesterFromRuns(
      deps().getSubagentRunsSnapshotForRead(runs),
      rootSessionKey,
    );
  }

  function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
    return getSubagentRunByChildSessionKeyFromRuns(
      deps().getSubagentRunsSnapshotForRead(runs),
      childSessionKey,
    );
  }

  function getLatestSubagentRunByChildSessionKey(
    childSessionKey: string,
  ): SubagentRunRecord | null {
    const key = childSessionKey.trim();
    if (!key) {
      return null;
    }

    let latest: SubagentRunRecord | null = null;
    for (const entry of deps().getSubagentRunsSnapshotForChildSession(runs, key).values()) {
      if (entry.childSessionKey !== key) {
        continue;
      }
      if (!latest || compareSubagentRunGeneration(entry, latest) > 0) {
        latest = entry;
      }
    }

    return latest;
  }

  /** Re-admits a delivered child batch after its requester explicitly yields. */
  function settleRequesterAfterSessionSpawns(params: {
    requesterSessionKey: string;
    requesterTurnRunId: string;
    requesterYielded: boolean;
    acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  }): boolean {
    return settleRequesterTurn(params);
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
    listSubagentRunsForController,
    getSubagentRunByRunId,
    getSubagentRunsByRunIds,
    completeCollectorLaunchCleanup,
    recordSwarmStructuredOutput,
    listSwarmRunsForGroup,
    getSwarmRunByLaunchReplayKey,
    countActiveRunsForSession,
    countActiveDescendantRuns,
    countPendingDescendantRuns,
    listDescendantRunsForRequester,
    getSubagentRunByChildSessionKey,
    getLatestSubagentRunByChildSessionKey,
    settleRequesterAfterSessionSpawns,
    markRequesterTurnYielded,
  };
}
