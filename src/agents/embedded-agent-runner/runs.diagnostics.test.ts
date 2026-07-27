import { afterEach, describe, expect, it } from "vitest";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcome,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

describe("embedded-agent run diagnostics", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    resetDiagnosticSessionStateForTest();
    setDiagnosticsEnabledForProcess(false);
  });

  it("does not retain active-run steering as idle session backlog", () => {
    setDiagnosticsEnabledForProcess(true);
    const queuedDepths: number[] = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "message.queued") {
        queuedDepths.push(event.queueDepth);
      }
    });
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    try {
      setActiveEmbeddedRun("session-steer-diagnostics", handle);

      expect(
        queueEmbeddedAgentMessageWithOutcome("session-steer-diagnostics", "first").queued,
      ).toBe(true);
      expect(
        queueEmbeddedAgentMessageWithOutcome("session-steer-diagnostics", "second").queued,
      ).toBe(true);

      clearActiveEmbeddedRun("session-steer-diagnostics", handle);
    } finally {
      unsubscribe();
    }

    expect(getDiagnosticSessionState({ sessionId: "session-steer-diagnostics" }).queueDepth).toBe(
      0,
    );
    expect(queuedDepths).toEqual([0, 0]);
  });
});
