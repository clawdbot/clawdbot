import { isChannelProgressDraftWorkToolName } from "./streaming.js";

/**
 * Per-turn work counters for live channel progress surfaces. These describe the
 * turn while it runs; nothing here survives into the finished transcript.
 */
export function createChannelProgressWorkCounter(params?: { now?: () => number }) {
  const now = params?.now ?? Date.now;
  let startedAt = now();
  let toolCalls = 0;

  return {
    noteToolCall(toolName?: string) {
      if (isChannelProgressDraftWorkToolName(toolName)) {
        toolCalls += 1;
      }
    },
    reset() {
      startedAt = now();
      toolCalls = 0;
    },
    get toolCalls() {
      return toolCalls;
    },
    get elapsedSeconds() {
      return Math.max(1, Math.round((now() - startedAt) / 1000));
    },
  };
}
