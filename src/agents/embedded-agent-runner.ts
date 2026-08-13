// Embedded-agent runner barrel. Focused submodules own run orchestration,
// compaction, queues, sandbox metadata, and SDK tool splitting.
export { compactEmbeddedAgentSession } from "./embedded-agent-runner/compact.queued.js";

export { resolveEmbeddedSessionLane } from "./embedded-agent-runner/lanes.js";
export { runEmbeddedAgent } from "./embedded-agent-runner/run.js";
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunAbortableForCompaction,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive,
  isEmbeddedAgentRunStreaming,
  queueEmbeddedAgentMessageWithOutcome,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  waitForEmbeddedAgentRunEnd,
} from "./embedded-agent-runner/runs.js";
export type {
  EmbeddedAgentMeta,
  EmbeddedAgentCompactResult,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "./embedded-agent-runner/types.js";
