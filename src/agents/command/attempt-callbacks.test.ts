// Verifies the small lifecycle callback adapter used during agent attempts.
import { describe, expect, it } from "vitest";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./attempt-callbacks.js";

describe("createAgentAttemptLifecycleCallbacks", () => {
  it("tracks user-message persistence without closing over the agent command scope", () => {
    const state: AgentAttemptLifecycleState = {
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

  it("tracks terminal lifecycle phases", async () => {
    const state = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
    expect(state.lifecycleEnded).toBe(false);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "end" } });
    expect(state.lifecycleEnded).toBe(true);
  });

  it("retains deferred lifecycle errors without marking the attempt terminal", async () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({
      stream: "lifecycle",
      data: { phase: "finishing", error: "provider failed" },
    });

    expect(state.lifecycleError).toBe("provider failed");
    expect(state.lifecycleFinishing).toBe(true);
    expect(state.lifecycleEnded).toBe(false);
  });

  it("replaces a failed candidate lifecycle when a retry starts", async () => {
    const state: AgentAttemptLifecycleState = {
      currentTurnUserMessagePersisted: true,
      lifecycleError: "provider failed",
      lifecycleErrorObservation: { provider: "openai", httpStatus: 502 },
      lifecycleFinishing: true,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });

    expect(state).toEqual({
      currentTurnUserMessagePersisted: true,
      lifecycleError: undefined,
      lifecycleErrorObservation: undefined,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    });
  });
});
