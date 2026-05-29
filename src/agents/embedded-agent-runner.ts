export { compactEmbeddedAgentSession } from "./embedded-agent-runner/compact.queued.js";
export { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";

export { resolveEmbeddedSessionLane } from "./embedded-agent-runner/lanes.js";
export { runEmbeddedAgent } from "./embedded-agent-runner/run.js";
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunStreaming,
  queueEmbeddedAgentMessage,
  queueEmbeddedAgentMessageWithOutcome,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionId as resolveActiveEmbeddedAgentRunSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  waitForEmbeddedAgentRunEnd,
} from "./embedded-agent-runner/runs.js";
export { buildEmbeddedSandboxInfo } from "./embedded-agent-runner/sandbox-info.js";
export { splitSdkTools } from "./embedded-agent-runner/tool-split.js";
export type {
  EmbeddedAgentMeta,
  EmbeddedAgentCompactResult,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "./embedded-agent-runner/types.js";
