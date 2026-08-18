import type { AgentMessage } from "../runtime/index.js";

/**
 * Keep internal memory-maintenance turns in the audit/model transcript without
 * projecting them into user-facing chat history.
 */
export function projectAgentHarnessTranscriptMessageForDisplay<T extends AgentMessage>(params: {
  hidden: boolean;
  message: T;
}): T {
  if (!params.hidden) {
    return params.message;
  }
  if (Reflect.get(params.message, "display") === false) {
    return params.message;
  }
  return Object.assign({}, params.message, { display: false });
}
