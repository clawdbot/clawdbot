import type { AgentMessage } from "../../runtime/index.js";
import type { UserTranscriptContext } from "./attempt.user-message-boundary.js";

/** Retains attempt-local runtime-to-transcript pairs across queued user turns. */
export function createUserTranscriptContextRegistry() {
  const contexts: UserTranscriptContext[] = [];

  const upsert = (runtimeMessage: AgentMessage, transcriptMessage: AgentMessage) => {
    const context = { runtimeMessage, transcriptMessage };
    const existingIndex = contexts.findIndex(
      (candidate) => candidate.runtimeMessage === runtimeMessage,
    );
    if (existingIndex === -1) {
      contexts.push(context);
    } else {
      contexts[existingIndex] = context;
    }
  };

  return {
    clear: () => {
      contexts.length = 0;
    },
    list: (latestRuntimeMessage?: AgentMessage, latestTranscriptMessage?: AgentMessage) => {
      if (latestRuntimeMessage && latestTranscriptMessage) {
        upsert(latestRuntimeMessage, latestTranscriptMessage);
      }
      return contexts as readonly UserTranscriptContext[];
    },
    record: upsert,
  };
}
