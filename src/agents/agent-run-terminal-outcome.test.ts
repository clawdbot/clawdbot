/** Tests normalized agent run terminal outcomes and sticky timeout/cancel behavior. */
import { describe, expect, it } from "vitest";
import {
  buildAgentRunTerminalOutcome,
  isHardAgentRunTimeoutPhase,
  mergeAgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";

describe("agent run terminal outcome", () => {
  it("treats provider/preflight/post-turn timeout phases as hard run timeouts", () => {
    expect(isHardAgentRunTimeoutPhase("preflight")).toBe(true);
    expect(isHardAgentRunTimeoutPhase("provider")).toBe(true);
    expect(isHardAgentRunTimeoutPhase("post_turn")).toBe(true);
    expect(isHardAgentRunTimeoutPhase("queue")).toBe(false);
    expect(isHardAgentRunTimeoutPhase("gateway_draining")).toBe(false);
  });

  it("keeps queue and gateway draining timeouts non-sticky", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
      }).reason,
    ).toBe("timed_out");
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
        timeoutPhase: "queue",
      }).reason,
    ).toBe("timed_out");
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
        timeoutPhase: "gateway_draining",
      }).reason,
    ).toBe("timed_out");
  });

  it("keeps explicit rpc and stop cancellations sticky even with queue attribution", () => {
    const rpcCancel = buildAgentRunTerminalOutcome({
      status: "timeout",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
      endedAt: 100,
    });
    const lateCompletion = buildAgentRunTerminalOutcome({
      status: "ok",
      endedAt: 200,
    });

    expect(rpcCancel.reason).toBe("cancelled");
    expect(rpcCancel.status).toBe("timeout");
    expect(mergeAgentRunTerminalOutcome(rpcCancel, lateCompletion)).toBe(rpcCancel);
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
        stopReason: "stop",
        timeoutPhase: "gateway_draining",
      }).reason,
    ).toBe("cancelled");
  });

  it("does not treat successful model stop metadata as cancellation", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "ok",
        stopReason: "stop",
      }),
    ).toEqual({
      reason: "completed",
      status: "ok",
      stopReason: "stop",
    });
  });

  it("does not treat successful provider-started metadata as timeout without attribution phase", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "ok",
        providerStarted: true,
      }),
    ).toEqual({
      reason: "completed",
      status: "ok",
      providerStarted: true,
    });
  });

  it("does not treat provider-started errors as timeouts without timeout attribution", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "error",
        error: "provider authentication failed",
        stopReason: "error",
        providerStarted: true,
      }),
    ).toMatchObject({
      reason: "failed",
      status: "error",
      error: "provider authentication failed",
      providerStarted: true,
    });
  });

  it("prefers hard timeout evidence over default rpc cancellation metadata", () => {
    const timeout = buildAgentRunTerminalOutcome({
      status: "timeout",
      stopReason: "rpc",
      timeoutPhase: "provider",
      providerStarted: true,
      endedAt: 200,
    });
    const earlierCompletion = buildAgentRunTerminalOutcome({
      status: "ok",
      endedAt: 190,
    });

    expect(timeout.reason).toBe("hard_timeout");
    expect(timeout.status).toBe("timeout");
    expect(mergeAgentRunTerminalOutcome(timeout, earlierCompletion)).toBe(earlierCompletion);
  });

  it("classifies provider timeout lifecycle errors as hard timeouts", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "error",
        error: "provider request timed out",
        stopReason: "error",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    ).toMatchObject({
      reason: "hard_timeout",
      status: "timeout",
      error: "provider request timed out",
    });
  });

  it("classifies timeout attribution metadata as a hard timeout even on end events", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "ok",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    ).toMatchObject({
      reason: "hard_timeout",
      status: "timeout",
    });
  });

  it("lets timeout attribution outrank blocked liveness", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "error",
        error: "provider request timed out",
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    ).toMatchObject({
      reason: "hard_timeout",
      status: "timeout",
      error: "provider request timed out",
      livenessState: "blocked",
    });
  });

  it("keeps a hard timeout over later aborts or failures for the same run", () => {
    const timeout = buildAgentRunTerminalOutcome({
      status: "timeout",
      timeoutPhase: "provider",
      endedAt: 200,
    });
    const lateAbort = buildAgentRunTerminalOutcome({
      status: "error",
      stopReason: "aborted",
      endedAt: 250,
    });
    const lateFailure = buildAgentRunTerminalOutcome({
      status: "error",
      error: "late rejection",
      endedAt: 260,
    });

    expect(mergeAgentRunTerminalOutcome(timeout, lateAbort)).toBe(timeout);
    expect(mergeAgentRunTerminalOutcome(timeout, lateFailure)).toBe(timeout);
  });

  it("lets an earlier proven completion correct a provisional timeout", () => {
    const timeout = buildAgentRunTerminalOutcome({
      status: "timeout",
      timeoutPhase: "provider",
      endedAt: 200,
    });
    const earlierCompletion = buildAgentRunTerminalOutcome({
      status: "ok",
      endedAt: 190,
    });

    expect(mergeAgentRunTerminalOutcome(timeout, earlierCompletion)).toBe(earlierCompletion);
  });
});
