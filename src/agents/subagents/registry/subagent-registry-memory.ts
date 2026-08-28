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

class SubagentRunMap extends Map<string, SubagentRunRecord> {
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
    super.clear();
    collectorRunIdByChildSessionKey.clear();
    runsByChildSessionKey.clear();
    runsByCollectorGroupKey.clear();
  }
}

export const subagentRuns: Map<string, SubagentRunRecord> = new SubagentRunMap();

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
