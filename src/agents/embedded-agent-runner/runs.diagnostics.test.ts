import { afterEach, describe, expect, it } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import { logMessageQueued, logSessionStateChange } from "../../logging/diagnostic.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcome,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

function startDiagnosticTurn(sessionId: string): void {
  logMessageQueued({ sessionId, source: "test-turn" });
  logSessionStateChange({ sessionId, state: "processing" });
}

function finishDiagnosticTurn(sessionId: string): void {
  logSessionStateChange({ sessionId, state: "idle" });
}

describe("active run injection diagnostics", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticSessionStateForTest();
    setDiagnosticsEnabledForProcess(false);
  });

  it("does not retain active-run steering as idle session backlog", () => {
    setDiagnosticsEnabledForProcess(true);
    const queuedDepths: Array<number | undefined> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "message.queued" && event.source === "embedded-agent-runner") {
        queuedDepths.push(event.queueDepth);
      }
    });
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    startDiagnosticTurn("session-steer-diagnostics");
    setActiveEmbeddedRun("session-steer-diagnostics", handle);
    try {
      expect(
        queueEmbeddedAgentMessageWithOutcome("session-steer-diagnostics", "first").queued,
      ).toBe(true);
      expect(
        queueEmbeddedAgentMessageWithOutcome("session-steer-diagnostics", "second").queued,
      ).toBe(true);
    } finally {
      clearActiveEmbeddedRun("session-steer-diagnostics", handle);
      finishDiagnosticTurn("session-steer-diagnostics");
      unsubscribe();
    }

    expect(getDiagnosticSessionState({ sessionId: "session-steer-diagnostics" }).queueDepth).toBe(
      0,
    );
    expect(queuedDepths).toEqual([1, 1]);
  });

  it("does not retain reply-run steering as idle session backlog", () => {
    setDiagnosticsEnabledForProcess(true);
    const queuedDepths: Array<number | undefined> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "message.queued" && event.source === "embedded-agent-runner") {
        queuedDepths.push(event.queueDepth);
      }
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:reply-steer-diagnostics",
      sessionId: "session-reply-steer-diagnostics",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "cli",
      cancel: () => {},
      isStreaming: () => true,
      queueMessage: async () => {},
    });
    operation.setPhase("running");
    try {
      startDiagnosticTurn("session-reply-steer-diagnostics");
      expect(
        queueEmbeddedAgentMessageWithOutcome("session-reply-steer-diagnostics", "first").queued,
      ).toBe(true);
      expect(
        queueEmbeddedAgentMessageWithOutcome("session-reply-steer-diagnostics", "second").queued,
      ).toBe(true);
    } finally {
      operation.complete();
      finishDiagnosticTurn("session-reply-steer-diagnostics");
      unsubscribe();
    }

    expect(
      getDiagnosticSessionState({ sessionId: "session-reply-steer-diagnostics" }).queueDepth,
    ).toBe(0);
    expect(queuedDepths).toEqual([1, 1]);
  });
});
