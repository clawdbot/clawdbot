import { stableStringify } from "@openclaw/normalization-core";
import {
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "./agent-steering-queue.js";
import { assertFactoryNativeAuthorityProof } from "./factory-authority-profile.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import type { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForControllerFromRuns,
} from "./subagent-registry-queries.js";
import { markRequesterTurnYieldedInRuns } from "./subagent-registry-requester-yield.js";
import type {
  SubagentRunRecord,
  SwarmEffectiveAuthorityProof,
  SwarmStructuredOutputState,
} from "./subagent-registry.types.js";

export function createSubagentRegistryPublicApi(config: {
  runs: Map<string, SubagentRunRecord>;
  deps: () => SubagentRegistryDeps;
  persist: (...runIds: string[]) => void;
  persistOrThrow: (...runIds: string[]) => void;
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
  const readRuns = () => deps().getSubagentRunsSnapshotForRead(runs);
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

  function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
    return listRunsForControllerFromRuns(
      deps().getSubagentRunsSnapshotForController(runs, controllerSessionKey),
      controllerSessionKey,
    );
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

  function completeCollectorLaunchCleanup(runId: string): void {
    const entry = findRunById(runs, runId.trim());
    if (!entry?.collectorLaunchCleanupPending) {
      return;
    }
    entry.collectorLaunchCleanupPending = false;
    entry.cleanupCompletedAt = Date.now();
    entry.contextEngineCleanupCompletedAt ??= entry.cleanupCompletedAt;
    persist(entry.runId);
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
    if (previous) {
      if (stableStringify(previous) === stableStringify(state)) {
        return;
      }
      if (previous.structured !== undefined) {
        throw new Error("collector structured output is already recorded with different content");
      }
    }
    entry.structuredOutput = structuredClone(state);
    try {
      persistOrThrow(entry.runId);
    } catch (error) {
      entry.structuredOutput = previous;
      throw error;
    }
  }

  function recordSwarmEffectiveAuthorityProof(params: {
    runId: string;
    launchIdentityDigest: `sha256:${string}`;
    proof: SwarmEffectiveAuthorityProof;
  }): void {
    const entry = findRunById(runs, params.runId.trim());
    if (
      !entry?.collect ||
      !entry.swarmLaunchAuthority ||
      entry.swarmLaunchIdentityDigest !== params.launchIdentityDigest ||
      entry.collectorCompletion ||
      entry.swarmTerminalEvidence
    ) {
      throw new Error("factory native collector run is unavailable for authority proof");
    }
    const proof = assertFactoryNativeAuthorityProof({
      binding: {
        runId: entry.swarmRunId ?? entry.runId,
        launchIdentityDigest: params.launchIdentityDigest,
        authority: entry.swarmLaunchAuthority,
      },
      proof: params.proof,
    });
    if (entry.swarmEffectiveAuthorityProof) {
      if (stableStringify(entry.swarmEffectiveAuthorityProof) !== stableStringify(proof)) {
        throw new Error("factory native effective authority proof is immutable");
      }
      return;
    }
    entry.swarmEffectiveAuthorityProof = proof;
    try {
      persistOrThrow(entry.runId);
    } catch (error) {
      entry.swarmEffectiveAuthorityProof = undefined;
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

  function countActiveDescendantRuns(rootSessionKey: string): number {
    return countActiveDescendantRunsFromRuns(readRuns(), rootSessionKey);
  }

  function countPendingDescendantRuns(rootSessionKey: string): number {
    return countPendingDescendantRunsFromRuns(readRuns(), rootSessionKey);
  }

  function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
    return listDescendantRunsForRequesterFromRuns(readRuns(), rootSessionKey);
  }

  function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
    return getSubagentRunByChildSessionKeyFromRuns(
      deps().getSubagentRunsSnapshotForChildSession(runs, childSessionKey),
      childSessionKey,
    );
  }

  function getLatestSubagentRunByChildSessionKey(
    childSessionKey: string,
  ): SubagentRunRecord | null {
    return (
      getLatestSubagentRunByChildSessionKeyFromRuns(
        deps().getSubagentRunsSnapshotForChildSession(runs, childSessionKey),
        childSessionKey,
      ) ?? null
    );
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
    recordSwarmEffectiveAuthorityProof,
    listSwarmRunsForGroup,
    getSwarmRunByLaunchReplayKey,
    countActiveRunsForSession,
    countActiveDescendantRuns,
    countPendingDescendantRuns,
    listDescendantRunsForRequester,
    getSubagentRunByChildSessionKey,
    getLatestSubagentRunByChildSessionKey,
    settleRequesterAfterSessionSpawns: settleRequesterTurn,
    markRequesterTurnYielded,
  };
}
