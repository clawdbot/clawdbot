/**
 * Lifecycle callback state helpers for a single agent attempt.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../runtime/index.js";

/** Mutable lifecycle flags observed while a single agent attempt runs. */
export type AgentAttemptLifecycleState = {
  currentTurnUserMessagePersisted: boolean;
  lifecycleError?: string;
  lifecycleErrorObservation?: Record<string, unknown>;
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
export function createAgentAttemptLifecycleCallbacks(
  state: AgentAttemptLifecycleState,
  onRuntimeTurnStarted?: () => void | Promise<void>,
): {
  onUserMessagePersisted: (message: Extract<AgentMessage, { role: "user" }>) => void;
  onAgentEvent: (evt: AgentAttemptLifecycleEvent) => void | Promise<void>;
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
        state.lifecycleErrorObservation = undefined;
        state.lifecycleFinishing = false;
        state.lifecycleEnded = false;
        return onRuntimeTurnStarted?.();
      }
      if (typeof evt.data.error === "string" && evt.data.error.trim()) {
        state.lifecycleError = evt.data.error;
        state.lifecycleErrorObservation = asOptionalRecord(evt.data.errorObservation);
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
