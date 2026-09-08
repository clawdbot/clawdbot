import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { observeAgentRunApprovalWait } from "./agent-run-approval-wait.js";

describe("observeAgentRunApprovalWait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts overlapping approvals once, ignores foreign sessions, and supports per-call baselines", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const wait = observeAgentRunApprovalWait({ runId: "run-1", sessionId: "session-1" });
    const event = (phase: string, approvalId: string, sessionId = "session-1") =>
      emitAgentEvent({
        runId: "run-1",
        sessionId,
        stream: "lifecycle",
        data: { phase, approvalId },
      });
    try {
      event("waiting-approval", "foreign", "session-2");
      expect(wait.pending).toBe(false);
      event("waiting-approval", "first");
      vi.advanceTimersByTime(5000);
      const baseline = wait.pausedMs;
      event("waiting-approval", "second");
      vi.advanceTimersByTime(200);
      event("approval-resolved", "first");
      expect(wait.pending).toBe(true);
      vi.advanceTimersByTime(300);
      event("approval-resolved", "second");
      expect(wait.pending).toBe(false);
      expect(wait.pausedMs - baseline).toBe(500);
      vi.advanceTimersByTime(100);
      expect(wait.pausedMs - baseline).toBe(500);
    } finally {
      wait.dispose();
    }
    event("waiting-approval", "after-dispose");
    expect(wait.pending).toBe(false);
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
