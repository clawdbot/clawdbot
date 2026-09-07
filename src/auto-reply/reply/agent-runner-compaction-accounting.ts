import type {
  CompactionAccountingFact,
  CompactionAccountingTarget,
} from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { AgentTurnCompaction } from "./agent-runner-execution.types.js";

export function hasSameCompactionWriter(
  previous: CompactionAccountingTarget | undefined,
  current: CompactionAccountingTarget,
): boolean {
  // Physical session IDs may rotate while the binding and retained writer stay fixed.
  return (
    previous !== undefined &&
    previous.agentId === current.agentId &&
    previous.sessionKey === current.sessionKey &&
    previous.storePath === current.storePath &&
    previous.lifecycleRevision === current.lifecycleRevision &&
    previous.activeWriterRunId === current.activeWriterRunId
  );
}

/** A later opaque candidate may lose freshness, but must never fabricate it. */
export function invalidateTurnCompactionContext(compaction: AgentTurnCompaction): void {
  compaction.durable = compaction.durable.map((fact) => ({
    ...fact,
    currentContextSnapshot: { tokens: undefined },
  }));
}

/** Fold same-writer facts; only an ordered snapshot may refresh context. */
export function recordTurnCompaction(
  compaction: AgentTurnCompaction,
  fact: CompactionAccountingFact,
): void {
  if (fact.count < 0) {
    return;
  }
  compaction.count += fact.count;
  if (fact.kind !== "durable") {
    return;
  }
  const index = compaction.durable.findIndex(({ target }) =>
    hasSameCompactionWriter(target, fact.target),
  );
  const previous = compaction.durable[index];
  if (!previous && fact.count === 0) {
    return;
  }
  if (previous) {
    compaction.durable.splice(index, 1);
  }
  // Custody without an observation cannot erase the prior candidate's explicit invalidation.
  compaction.durable.push({
    ...fact,
    count: (previous?.count ?? 0) + fact.count,
    currentContextSnapshot: fact.currentContextSnapshot ?? previous?.currentContextSnapshot,
  });
}
