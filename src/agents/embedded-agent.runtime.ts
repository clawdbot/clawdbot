/**
 * Embedded agent runtime barrel.
 *
 * Runtime callers import this surface for run lifecycle helpers without pulling
 * in the larger embedded-agent module path directly.
 */
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunStreaming,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  runEmbeddedAgent,
  resolveEmbeddedSessionLane,
  waitForEmbeddedAgentRunEnd,
} from "./embedded-agent.js";
