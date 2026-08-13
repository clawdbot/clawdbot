/**
 * Lifecycle callback state helpers for a single agent attempt.
 */
import type { AgentMessage } from "../runtime/index.js";

/** Mutable lifecycle flags observed while a single agent attempt runs. */
export type AgentAttemptLifecycleState = {
  currentTurnUserMessagePersisted: boolean;
  lifecycleError?: string;
  lifecycleFinishing: boolean;
  lifecycleEnded: boolean;
};

/** Event shape emitted by runtimes during an agent attempt. */
type AgentAttemptLifecycleEvent = {
  stream: string;
  data?: Record<string, unknown>;
  sessionKey?: string;
};

/** Creates callbacks that update lifecycle flags for persistence decisions. */
export function createAgentAttemptLifecycleCallbacks(state: AgentAttemptLifecycleState): {
  onUserMessagePersisted: (message: Extract<AgentMessage, { role: "user" }>) => void;
  onAgentEvent: (evt: AgentAttemptLifecycleEvent) => void;
} {
  return {
    onUserMessagePersisted: () => {
      state.currentTurnUserMessagePersisted = true;
    },
    onAgentEvent: (evt) => {
      if (evt.stream !== "lifecycle" || typeof evt.data?.phase !== "string") {
        return;
      }
      if (evt.data.phase === "start") {
        // A same-candidate retry replaces deferred terminal state from the
        // preceding attempt; retaining it would abort a recovered run.
        state.lifecycleError = undefined;
        state.lifecycleFinishing = false;
        state.lifecycleEnded = false;
        return;
      }
      if (typeof evt.data.error === "string" && evt.data.error.trim()) {
        state.lifecycleError = evt.data.error;
      }
      // Finishing means output ended but transcript/session persistence may still
      // need to run; end/error means the runtime lifecycle is complete.
      if (evt.data.phase === "finishing") {
        state.lifecycleFinishing = true;
        return;
      }
      if (evt.data.phase === "end" || evt.data.phase === "error") {
        state.lifecycleEnded = true;
      }
    },
  };
}
