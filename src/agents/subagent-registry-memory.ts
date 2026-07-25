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
// manager, tests); collect/childSessionKey are fixed at registration, so
// in-place field edits never require re-indexing.
const collectorRunIdByChildSessionKey = new Map<string, string>();

class SubagentRunMap extends Map<string, SubagentRunRecord> {
  override set(runId: string, entry: SubagentRunRecord): this {
    const prev = this.get(runId);
    if (prev?.collect === true && prev.childSessionKey) {
      collectorRunIdByChildSessionKey.delete(prev.childSessionKey);
    }
    super.set(runId, entry);
    if (entry.collect === true && entry.childSessionKey) {
      collectorRunIdByChildSessionKey.set(entry.childSessionKey, runId);
    }
    return this;
  }

  override delete(runId: string): boolean {
    const prev = this.get(runId);
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
  }
}

export const subagentRuns: Map<string, SubagentRunRecord> = new SubagentRunMap();

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
