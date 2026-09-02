/**
 * Process-local live subagent run map.
 *
 * Shared by registry read/write helpers for active in-memory run state.
 */
import { isDeepStrictEqual } from "node:util";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Preflight consults the collector lookup on every Gateway agent request, so it
// must stay O(1) regardless of retained collector records. The map subclass
// maintains the index through every existing mutation path (registry, run
// manager, tests); collector identity and childSessionKey are fixed at
// registration, so in-place lifecycle field edits never require re-indexing.
const collectorRunIdByChildSessionKey = new Map<string, string>();
const runsByChildSessionKey = new Map<string, Map<string, SubagentRunRecord>>();
const runsByCollectorGroupKey = new Map<string, Map<string, SubagentRunRecord>>();

function collectorGroupKey(entry: SubagentRunRecord): string | undefined {
  if (entry.collect !== true || !entry.groupId) {
    return undefined;
  }
  return JSON.stringify([
    entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
    entry.groupId,
  ]);
}

function removeIndexedSubagentRun(
  index: Map<string, Map<string, SubagentRunRecord>>,
  key: string | undefined,
  runId: string,
  entry: SubagentRunRecord,
) {
  if (!key) {
    return;
  }
  const indexedRuns = index.get(key);
  if (indexedRuns?.get(runId) !== entry) {
    return;
  }
  indexedRuns.delete(runId);
  if (indexedRuns.size === 0) {
    index.delete(key);
  }
}

function indexSubagentRun(
  index: Map<string, Map<string, SubagentRunRecord>>,
  key: string | undefined,
  runId: string,
  entry: SubagentRunRecord,
) {
  if (!key) {
    return;
  }
  const indexedRuns = index.get(key);
  if (indexedRuns) {
    indexedRuns.set(runId, entry);
  } else {
    index.set(key, new Map([[runId, entry]]));
  }
}

type SubagentRetirementScope = {
  observation:
    | ({ entry: SubagentRunRecord; state: "selected" | "retired" } & Pick<
        SubagentRunRecord,
        "generation" | "createdAt"
      >)
    | { entry?: never; generation?: never; createdAt?: never; state: "superseded" };
  isSuccessor: (candidate: SubagentRunRecord) => boolean;
};

class SubagentRunMap extends Map<string, SubagentRunRecord> {
  private readonly retirementScopes = new Set<SubagentRetirementScope>();

  /** A cancellation borrows retirement evidence only for its own lexical lifetime. */
  captureRetirement(
    entry: SubagentRunRecord,
    isSuccessor: (candidate: SubagentRunRecord) => boolean,
  ) {
    const scope: SubagentRetirementScope = {
      observation: {
        entry,
        generation: entry.generation,
        createdAt: entry.createdAt,
        state: "selected",
      },
      isSuccessor,
    };
    this.retirementScopes.add(scope);
    return {
      get observation() {
        return scope.observation;
      },
      release: () => {
        scope.observation = { state: "superseded" };
        this.retirementScopes.delete(scope);
      },
    };
  }

  /** Publish only accepted ownership, after synchronous registration/recovery rollback decisions. */
  commitOwnership(entry: SubagentRunRecord): void {
    if (this.get(entry.runId) !== entry) {
      return;
    }
    for (const scope of this.retirementScopes) {
      const previous = scope.observation.entry;
      if (
        previous &&
        previous !== entry &&
        previous.childSessionKey === entry.childSessionKey &&
        scope.isSuccessor(entry)
      ) {
        const receipt = previous.execution.restartRecovery;
        // Follow only the committed receipt handoff. An ordinary displacement closes
        // this operation permanently, even if its row disappears before Stop resumes.
        scope.observation =
          receipt?.phase === "accepted" &&
          receipt.idempotencyKey === entry.runId &&
          entry.execution.restartRecovery === receipt
            ? {
                entry,
                generation: entry.generation,
                createdAt: entry.createdAt,
                state: "selected",
              }
            : { state: "superseded" };
      }
    }
  }

  /** Normal cleanup calls this only after its deletion commits; raw map deletion is not evidence. */
  confirmRetirement(entry: SubagentRunRecord): void {
    for (const scope of this.retirementScopes) {
      const observed = scope.observation;
      if (
        observed.entry === entry &&
        observed.state === "selected" &&
        this.get(entry.runId) !== entry
      ) {
        observed.state = "retired";
      }
    }
  }

  override set(runId: string, entry: SubagentRunRecord): this {
    const prev = this.get(runId);
    if (prev) {
      removeIndexedSubagentRun(runsByChildSessionKey, prev.childSessionKey, runId, prev);
      removeIndexedSubagentRun(runsByCollectorGroupKey, collectorGroupKey(prev), runId, prev);
      if (prev.collect === true && prev.childSessionKey) {
        collectorRunIdByChildSessionKey.delete(prev.childSessionKey);
      }
    }
    super.set(runId, entry);
    indexSubagentRun(runsByChildSessionKey, entry.childSessionKey, runId, entry);
    indexSubagentRun(runsByCollectorGroupKey, collectorGroupKey(entry), runId, entry);
    if (entry.collect === true && entry.childSessionKey) {
      collectorRunIdByChildSessionKey.set(entry.childSessionKey, runId);
    }
    return this;
  }

  override delete(runId: string): boolean {
    const prev = this.get(runId);
    if (prev) {
      removeIndexedSubagentRun(runsByChildSessionKey, prev.childSessionKey, runId, prev);
      removeIndexedSubagentRun(runsByCollectorGroupKey, collectorGroupKey(prev), runId, prev);
    }
    if (
      prev?.collect === true &&
      prev.childSessionKey &&
      collectorRunIdByChildSessionKey.get(prev.childSessionKey) === runId
    ) {
      collectorRunIdByChildSessionKey.delete(prev.childSessionKey);
    }
    return super.delete(runId);
  }

  override clear(): void {
    for (const scope of this.retirementScopes) {
      scope.observation = { state: "superseded" };
    }
    this.retirementScopes.clear();
    super.clear();
    collectorRunIdByChildSessionKey.clear();
    runsByChildSessionKey.clear();
    runsByCollectorGroupKey.clear();
  }
}

export const subagentRuns = new SubagentRunMap();

/** Iterate live generations for one child session without scanning the registry. */
export function getSubagentRunsForChildSession(
  childSessionKey: string,
): Iterable<SubagentRunRecord> {
  return runsByChildSessionKey.get(childSessionKey)?.values() ?? [];
}

/** Iterate live collector members for one requester/group archive decision. */
export function getSubagentRunsForCollectorGroup(
  requesterSessionKey: string,
  groupId: string,
): Iterable<[string, SubagentRunRecord]> {
  const key = JSON.stringify([requesterSessionKey, groupId]);
  return runsByCollectorGroupKey.get(key)?.entries() ?? [];
}

/** Resolve a collector tombstone that reserves its child session from ordinary turns. */
export function findSwarmCollectorSession(childSessionKey?: string): SubagentRunRecord | undefined {
  const key = childSessionKey?.trim();
  if (!key) {
    return undefined;
  }
  const runId = collectorRunIdByChildSessionKey.get(key);
  return runId ? subagentRuns.get(runId) : undefined;
}

/** Resolve the host-registered collector that authorizes a Gateway request. */
export function findAuthorizedSwarmCollectorRequest(params: {
  childSessionKey?: string;
  idempotencyKey?: string;
  outputSchema?: Record<string, unknown>;
}): SubagentRunRecord | undefined {
  const idempotencyKey = params.idempotencyKey?.trim();
  if (!idempotencyKey) {
    return undefined;
  }
  const entry = findSwarmCollectorSession(params.childSessionKey);
  if (!entry) {
    return undefined;
  }
  return entry.swarmLaunchIdempotencyKey === idempotencyKey &&
    isDeepStrictEqual(entry.outputSchema, params.outputSchema)
    ? entry
    : undefined;
}
