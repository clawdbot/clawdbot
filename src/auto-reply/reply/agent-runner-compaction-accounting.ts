import type { CompactionAccountingFact } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { AgentTurnCompaction } from "./agent-runner-execution.types.js";

/** A later opaque candidate may lose freshness, but must never fabricate it. */
export function invalidateTurnCompactionContext(compaction: AgentTurnCompaction): void {
  compaction.durable = compaction.durable.map((fact) => ({
    ...fact,
    currentContextTokens: undefined,
  }));
}

/** Fold only observations belonging to the same retained writer; zero counts refresh context. */
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
  const index = compaction.durable.findIndex(
    ({ target }) =>
      target.agentId === fact.target.agentId &&
      target.sessionKey === fact.target.sessionKey &&
      target.storePath === fact.target.storePath &&
      target.lifecycleRevision === fact.target.lifecycleRevision &&
      target.activeWriterRunId === fact.target.activeWriterRunId,
  );
  const previous = compaction.durable[index];
  if (!previous && fact.count === 0) {
    return;
  }
  if (previous) {
    compaction.durable.splice(index, 1);
  }
  compaction.durable.push({ ...fact, count: (previous?.count ?? 0) + fact.count });
}
