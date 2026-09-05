import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { observeAgentRunApprovalWait } from "./agent-run-approval-wait.js";

describe("observeAgentRunApprovalWait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not report a negative pause when the wall clock rolls back", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(100);
    const wait = observeAgentRunApprovalWait({ runId: "run-1", sessionId: "session-1" });

    emitAgentEvent({
      runId: "run-1",
      sessionId: "session-1",
      stream: "lifecycle",
      data: { phase: "waiting-approval", approvalId: "approval-1" },
    });
    vi.advanceTimersByTime(25);
    vi.setSystemTime(50);
    emitAgentEvent({
      runId: "run-1",
      sessionId: "session-1",
      stream: "lifecycle",
      data: { phase: "approval-resolved", approvalId: "approval-1" },
    });

    expect(wait.pausedMs).toBe(25);
    wait.dispose();
  });
});
