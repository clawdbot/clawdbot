/** Tests normalized agent run terminal outcomes and sticky timeout/cancel behavior. */
import { describe, expect, it } from "vitest";
import {
  buildAgentRunTerminalOutcome,
  mergeAgentRunAttemptTerminal,
  mergeAgentRunTerminalOutcome,
  normalizeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  setAgentRunAttemptTerminalFailure,
  type AgentRunAttemptTerminal,
} from "./agent-run-terminal-outcome.js";

describe("agent run terminal outcome", () => {
  it("treats provider/preflight/post-turn timeout phases as hard run timeouts", () => {
    expect(
      ["preflight", "provider", "post_turn", "queue", "gateway_draining"].map(
        (timeoutPhase) =>
          buildAgentRunTerminalOutcome({
            status: "timeout",
            timeoutPhase,
          }).reason,
      ),
    ).toEqual(["hard_timeout", "hard_timeout", "hard_timeout", "timed_out", "timed_out"]);
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
    expect(rpcCancel.status).toBe("error");
    expect(mergeAgentRunTerminalOutcome(rpcCancel, lateCompletion)).toBe(rpcCancel);
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
        stopReason: "stop",
        timeoutPhase: "gateway_draining",
      }).reason,
    ).toBe("cancelled");
  });

  it("keeps restart cancellation sticky over late completion", () => {
    const restartCancel = buildAgentRunTerminalOutcome({
      status: "timeout",
      stopReason: "restart",
      timeoutPhase: "gateway_draining",
      providerStarted: true,
      endedAt: 100,
    });
    const lateCompletion = buildAgentRunTerminalOutcome({
      status: "ok",
      endedAt: 200,
    });

    expect(restartCancel).toMatchObject({
      reason: "cancelled",
      status: "error",
      stopReason: "restart",
    });
    expect(mergeAgentRunTerminalOutcome(restartCancel, lateCompletion)).toBe(restartCancel);
  });

  it("keeps explicit provider timeout attribution ahead of restart cancellation", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
        stopReason: "restart",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    ).toMatchObject({
      reason: "hard_timeout",
      status: "timeout",
      stopReason: "restart",
      timeoutPhase: "provider",
    });
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

  it("classifies abandoned successful waits as incomplete failures", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "ok",
        livenessState: "abandoned",
      }),
    ).toEqual({
      reason: "abandoned",
      status: "error",
      error: "Agent run ended before producing a complete result.",
      livenessState: "abandoned",
    });
  });

  it("keeps explicit cancellation ahead of abandoned liveness", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "error",
        stopReason: "stop",
        livenessState: "abandoned",
      }),
    ).toEqual({
      reason: "cancelled",
      status: "error",
      stopReason: "stop",
      livenessState: "abandoned",
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

describe("agent run attempt terminal", () => {
  it("keeps timeout phase and source precedence in the canonical owner", () => {
    const failure = new Error("provider failed while aborting");
    const failed = mergeAgentRunAttemptTerminal(
      { kind: "ok" },
      { kind: "failed", source: "prompt", error: failure },
    );
    const externallyAborted = mergeAgentRunAttemptTerminal(failed, {
      kind: "aborted",
      source: "external",
    });
    const timedOut = mergeAgentRunAttemptTerminal(externallyAborted, {
      kind: "timeout",
      phase: "compaction",
      source: "run_budget",
    });

    expect(timedOut).toEqual({
      kind: "timeout",
      phase: "compaction",
      source: "external",
      aborted: true,
      failure: { source: "prompt", error: failure },
    });

    expect(
      mergeAgentRunAttemptTerminal(
        { kind: "timeout", phase: "prompt", source: "idle" },
        { kind: "aborted", source: "external" },
      ),
    ).toEqual({ kind: "timeout", phase: "prompt", source: "external", aborted: true });
    expect(
      mergeAgentRunAttemptTerminal(
        { kind: "aborted", source: "runtime" },
        { kind: "timeout", phase: "compaction", source: "observation" },
      ),
    ).toEqual({ kind: "aborted", source: "runtime", timeoutObservation: "compaction" });
    expect(
      mergeAgentRunAttemptTerminal(
        { kind: "aborted", source: "external" },
        { kind: "aborted", source: "yield_cleanup" },
      ),
    ).toEqual({ kind: "aborted", source: "external" });
    expect(
      mergeAgentRunAttemptTerminal(
        { kind: "aborted", source: "runtime" },
        { kind: "aborted", source: "yield_cleanup" },
      ),
    ).toEqual({ kind: "aborted", source: "runtime" });
    const observedAbort = mergeAgentRunAttemptTerminal(
      { kind: "aborted", source: "runtime" },
      { kind: "timeout", phase: "compaction", source: "observation" },
    );
    expect(
      mergeAgentRunAttemptTerminal(observedAbort, {
        kind: "aborted",
        source: "external",
      }),
    ).toEqual({
      kind: "aborted",
      source: "external",
      timeoutObservation: "compaction",
    });
    expect(
      mergeAgentRunAttemptTerminal(observedAbort, {
        kind: "timeout",
        phase: "prompt",
        source: "runtime",
      }),
    ).toEqual({ kind: "timeout", phase: "compaction", source: "runtime", aborted: true });
    expect(
      mergeAgentRunAttemptTerminal(
        { kind: "timeout", phase: "prompt", source: "runtime" },
        { kind: "timeout", phase: "compaction", source: "observation" },
      ),
    ).toEqual({ kind: "timeout", phase: "compaction", source: "runtime" });
    const failedObservation = {
      kind: "failed" as const,
      source: "compaction" as const,
      error: failure,
      timeoutObservation: "compaction" as const,
    };
    expect(
      mergeAgentRunAttemptTerminal(
        { kind: "failed", source: "compaction", error: failure },
        { kind: "timeout", phase: "compaction", source: "observation" },
      ),
    ).toEqual(failedObservation);
    expect(
      mergeAgentRunAttemptTerminal(
        { kind: "timeout", phase: "compaction", source: "observation" },
        { kind: "failed", source: "compaction", error: failure },
      ),
    ).toEqual(failedObservation);
  });

  it("converges across terminal observation orderings", () => {
    const error = new Error("provider failed");
    const facts = [
      { kind: "failed", source: "prompt", error },
      { kind: "aborted", source: "runtime" },
      { kind: "timeout", phase: "compaction", source: "observation" },
      { kind: "timeout", phase: "prompt", source: "runtime" },
    ] as const;
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ] as const;

    for (const order of orders) {
      const terminal = order.reduce<AgentRunAttemptTerminal>(
        (current, index) => mergeAgentRunAttemptTerminal(current, facts[index]),
        { kind: "ok" },
      );
      expect(terminal).toEqual({
        kind: "timeout",
        phase: "compaction",
        source: "runtime",
        aborted: true,
        failure: { source: "prompt", error },
      });
    }
  });

  it("projects canonical terminal variants into the existing event fields", () => {
    expect(
      projectAgentRunAttemptTerminal({
        kind: "timeout",
        phase: "tool_execution",
        source: "idle",
      }),
    ).toMatchObject({
      idleTimedOut: true,
      timedOut: true,
      timedOutDuringToolExecution: true,
    });
    expect(
      projectAgentRunAttemptTerminal({ kind: "aborted", source: "yield_cleanup" }),
    ).toMatchObject({ aborted: false, cleanupYieldAborted: true });
    expect(
      projectAgentRunAttemptTerminal({ kind: "failed", source: "prompt", error: null }),
    ).toMatchObject({ failed: true, interrupted: false, promptError: null });
    expect(
      projectAgentRunAttemptTerminal({
        kind: "timeout",
        phase: "prompt",
        source: "runtime",
        failure: { source: "prompt", error: null },
      }),
    ).toMatchObject({ failed: true, interrupted: true, timedOut: true });
    expect(
      projectAgentRunAttemptTerminal({
        kind: "timeout",
        phase: "compaction",
        source: "observation",
      }),
    ).toMatchObject({ timedOut: false, timedOutDuringCompaction: true });
  });

  it("normalizes the shipped harness shape through the same precedence owner", () => {
    const error = new Error("request timed out");
    expect(
      normalizeAgentRunAttemptTerminal({
        aborted: true,
        externalAbort: true,
        promptError: error,
        promptErrorSource: "prompt",
        timedOut: true,
        timedOutDuringCompaction: true,
      }),
    ).toEqual({
      kind: "timeout",
      phase: "compaction",
      source: "external",
      aborted: true,
      failure: { source: "prompt", error },
    });
    expect(
      normalizeAgentRunAttemptTerminal({
        timedOut: true,
        idleTimedOut: true,
        timedOutByRunBudget: true,
      }),
    ).toEqual({ kind: "timeout", phase: "prompt", source: "run_budget" });
    expect(normalizeAgentRunAttemptTerminal({ timedOutByRunBudget: true })).toEqual({
      kind: "timeout",
      phase: "prompt",
      source: "run_budget",
    });
    expect(
      projectAgentRunAttemptTerminal(normalizeAgentRunAttemptTerminal({ timedOut: true })),
    ).toMatchObject({ timedOut: true, aborted: false });
    expect(normalizeAgentRunAttemptTerminal({ externalAbort: true })).toEqual({
      kind: "aborted",
      source: "external",
    });
    expect(
      normalizeAgentRunAttemptTerminal({
        promptError: error,
        promptErrorSource: "compaction",
        timedOutDuringCompaction: true,
      }),
    ).toEqual({
      kind: "failed",
      source: "compaction",
      error,
      timeoutObservation: "compaction",
    });
    const abortedCompaction = normalizeAgentRunAttemptTerminal({
      aborted: true,
      timedOutDuringCompaction: true,
    });
    expect(abortedCompaction).toEqual({
      kind: "aborted",
      source: "runtime",
      timeoutObservation: "compaction",
    });
    expect(projectAgentRunAttemptTerminal(abortedCompaction)).toMatchObject({
      aborted: true,
      timedOut: false,
      timedOutDuringCompaction: true,
    });
    expect(
      setAgentRunAttemptTerminalFailure(
        {
          kind: "failed",
          source: "compaction",
          error,
          timeoutObservation: "compaction",
        },
        { source: "prompt", error: new Error("replacement") },
      ),
    ).toMatchObject({
      kind: "failed",
      source: "prompt",
      timeoutObservation: "compaction",
    });
  });
});
