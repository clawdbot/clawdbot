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
  const record = params.message as unknown as Record<string, unknown>;
  if (record.display === false) {
    return params.message;
  }
  return { ...record, display: false } as unknown as T;
}
