// Public embedded-agent barrel. Re-export the runner API used by gateway,
// command, and plugin surfaces without exposing internal runner file layout.
export type {
  EmbeddedAgentCompactResult,
  EmbeddedAgentMeta,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "./embedded-agent-runner.js";
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  compactEmbeddedAgentSession,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunStreaming,
  queueEmbeddedAgentMessage,
  queueEmbeddedAgentMessageWithOutcome,
  resolveActiveEmbeddedAgentRunSessionId,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  resolveEmbeddedSessionLane,
  runEmbeddedAgent,
  waitForEmbeddedAgentRunEnd,
} from "./embedded-agent-runner.js";
