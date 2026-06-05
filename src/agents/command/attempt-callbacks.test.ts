// Verifies the small lifecycle callback adapter used during agent attempts.
import { describe, expect, it } from "vitest";
import { createAgentAttemptLifecycleCallbacks } from "./attempt-callbacks.js";

describe("createAgentAttemptLifecycleCallbacks", () => {
  it("tracks user-message persistence without closing over the agent command scope", () => {
    const state = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    // The callback mutates only the shared lifecycle state object; it should not
    // need access to the wider runAgentAttempt closure.
    callbacks.onUserMessagePersisted?.({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    expect(state.currentTurnUserMessagePersisted).toBe(true);
    expect(state.lifecycleEnded).toBe(false);
  });

  it("tracks terminal lifecycle phases", () => {
    const state = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
    expect(state.lifecycleEnded).toBe(false);

    callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "end" } });
    expect(state.lifecycleEnded).toBe(true);
  });
});
