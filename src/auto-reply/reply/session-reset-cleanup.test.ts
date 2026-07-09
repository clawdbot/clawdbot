// Tests session reset cleanup for stale files and persisted state.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedSessionPromptState,
  testing as sessionPromptStateTesting,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import {
  createReplyOperation,
  replyRunRegistry,
  testing as replyRunTesting,
} from "./reply-run-registry.js";
import { clearSessionResetRuntimeState } from "./session-reset-cleanup.js";

afterEach(() => {
  sessionPromptStateTesting.reset();
  replyRunTesting.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  resetSystemEventsForTest();
});

describe("clearSessionResetRuntimeState", () => {
  it("disposes prompt projections with the archived session", () => {
    const state = getEmbeddedSessionPromptState("old-session");
    state.sentUserTurnIds.add("sent-user-turn");

    clearSessionResetRuntimeState(["old-session"]);

    expect(getEmbeddedSessionPromptState("old-session")).not.toBe(state);
  });

  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", { sessionKey: "alpha" });
    enqueueSystemEvent("stale beta", { sessionKey: "beta" });
    enqueueSystemEvent("fresh gamma", { sessionKey: "gamma" });

    const result = clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"]);

    expect(result.keys).toEqual(["alpha", "beta"]);
    expect(result.systemEventsCleared).toBe(2);
    expect(peekSystemEvents("alpha")).toStrictEqual([]);
    expect(peekSystemEvents("beta")).toStrictEqual([]);
    expect(peekSystemEvents("gamma")).toEqual(["fresh gamma"]);
  });

  it("releases active reply work owned by the archived reset session id", () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      activeReplySessionId: "old-session",
    });

    expect(cancel).toHaveBeenCalledWith("restart");
    expect(replyRunRegistry.isActive("agent:main:slack:room:1")).toBe(false);
    const nextOperation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "new-session",
      resetTriggered: false,
    });
    expect(nextOperation.sessionId).toBe("new-session");
  });

  it("does not clear a fresh active reply under the same key when only the archived id is reset", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "new-session",
      resetTriggered: false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      activeReplySessionId: "old-session",
    });

    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(operation);
  });

  it("does not clear a replacement admitted while the archived run is cancelling", () => {
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel() {
        operation.complete();
        replacement = createReplyOperation({
          sessionKey: "agent:main:slack:room:1",
          sessionId: "old-session",
          resetTriggered: false,
        });
        replacement.setPhase("running");
      },
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      activeReplySessionId: "old-session",
    });

    expect(replacement).toBeDefined();
    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(replacement);
  });

  it("leaves queued reservations for the archived id so session init can rebind them", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      activeReplySessionId: "old-session",
    });

    expect(operation.phase).toBe("queued");
    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(operation);
  });
});
