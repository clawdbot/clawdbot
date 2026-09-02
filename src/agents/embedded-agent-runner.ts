// Embedded-agent runner barrel. Focused submodules own run orchestration,
// compaction, queues, sandbox metadata, and SDK tool splitting.
export { compactEmbeddedAgentSession } from "./embedded-agent-runner/compact.queued.js";
export { resolveActiveEmbeddedRunSessionId } from "./embedded-agent-runner/active-run-projections.js";

export { resolveEmbeddedSessionLane } from "./embedded-agent-runner/lanes.js";
export { runEmbeddedAgent } from "./embedded-agent-runner/run.js";
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  preemptAndDrainEmbeddedHeartbeatRun,
  isEmbeddedAgentRunAbortableForCompaction,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive,
  isEmbeddedAgentRunStreaming,
  queueEmbeddedAgentMessageWithOutcome,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  waitForEmbeddedAgentRunEnd,
} from "./embedded-agent-runner/runs.js";
export type {
  EmbeddedAgentMeta,
  EmbeddedAgentCompactResult,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "./embedded-agent-runner/types.js";
