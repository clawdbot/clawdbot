/** Tests normalized agent run terminal outcomes and sticky timeout/cancel behavior. */
import { describe, expect, it } from "vitest";
import {
  buildAgentRunTerminalOutcome,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  isStickyAgentRunTerminalOutcome,
  mergeAgentRunAttemptTerminal,
  mergeAgentRunTerminalOutcome,
  normalizeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  setAgentRunAttemptTerminalFailure,
  type AgentRunAttemptTerminal,
} from "./agent-run-terminal-outcome.js";

describe("agent run terminal outcome", () => {
  it.each([
    ["completed", "success"],
    ["hard_timeout", "timeout"],
    ["timed_out", "timeout"],
    ["superseded", "cancellation"],
    ["cancelled", "cancellation"],
    ["aborted", "cancellation"],
    ["blocked", "failure"],
    ["abandoned", "failure"],
    ["failed", "failure"],
  ] as const)("classifies %s as %s", (reason, classification) => {
    expect(classifyAgentRunTerminalOutcome({ reason })).toBe(classification);
  });

  it("normalizes lifecycle signals with timeout, cancellation, failure precedence", () => {
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: "end",
        data: { aborted: true },
      }),
    ).toMatchObject({ reason: "aborted", status: "error", stopReason: "aborted" });
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: "end",
        data: { aborted: true, stopReason: "timeout", timeoutPhase: "provider" },
      }),
    ).toMatchObject({ reason: "hard_timeout", status: "timeout" });
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: "error",
        data: { error: "provider failed" },
      }),
    ).toMatchObject({ reason: "failed", status: "error", error: "provider failed" });
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: "end",
        data: { status: "cancelled", stopReason: "relay-closed" },
      }),
    ).toMatchObject({ reason: "cancelled", status: "error", stopReason: "relay-closed" });
    const superseded = buildAgentRunTerminalOutcomeFromLifecycleEvent({
      phase: "end",
      data: { aborted: true, status: "superseded", stopReason: "superseded" },
    });
    expect(superseded).toMatchObject({
      reason: "superseded",
      status: "error",
      stopReason: "superseded",
    });
    expect(isStickyAgentRunTerminalOutcome(superseded)).toBe(true);
  });

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

  it("keeps the first proven sticky outcome regardless of callback ordering", () => {
    const timeout = buildAgentRunTerminalOutcome({
      status: "timeout",
      timeoutPhase: "provider",
      endedAt: 200,
    });
    const earlierCancellation = buildAgentRunTerminalOutcome({
      status: "error",
      stopReason: "rpc",
      endedAt: 190,
    });
    const laterCancellation = buildAgentRunTerminalOutcome({
      status: "error",
      stopReason: "restart",
      endedAt: 210,
    });

    for (const [current, incoming] of [
      [timeout, earlierCancellation],
      [earlierCancellation, timeout],
    ] as const) {
      expect(mergeAgentRunTerminalOutcome(current, incoming)).toBe(earlierCancellation);
    }
    for (const [current, incoming] of [
      [timeout, laterCancellation],
      [laterCancellation, timeout],
    ] as const) {
      expect(mergeAgentRunTerminalOutcome(current, incoming)).toBe(timeout);
    }
  });

  it("keeps explicit provider timeout attribution ahead of simultaneous cancellation", () => {
    const timeout = buildAgentRunTerminalOutcome({
      status: "timeout",
      timeoutPhase: "provider",
      endedAt: 200,
    });
    const cancellation = buildAgentRunTerminalOutcome({
      status: "error",
      stopReason: "rpc",
      endedAt: 200,
    });

    expect(mergeAgentRunTerminalOutcome(timeout, cancellation)).toBe(timeout);
    expect(mergeAgentRunTerminalOutcome(cancellation, timeout)).toBe(timeout);
  });

  it("keeps supersession over generic cancellation regardless of callback ordering", () => {
    const superseded = buildAgentRunTerminalOutcome({
      status: "error",
      stopReason: "superseded",
      endedAt: 200,
    });
    const cancellation = buildAgentRunTerminalOutcome({
      status: "error",
      stopReason: "rpc",
      endedAt: 201,
    });

    expect(mergeAgentRunTerminalOutcome(superseded, cancellation)).toBe(superseded);
    expect(mergeAgentRunTerminalOutcome(cancellation, superseded)).toBe(superseded);
  });

  it.each([
    { supersededAt: 190, expected: "superseded" },
    { supersededAt: 200, expected: "hard_timeout" },
    { supersededAt: 210, expected: "hard_timeout" },
  ] as const)(
    "keeps the first hard terminal between timeout and supersession at $supersededAt",
    ({ supersededAt, expected }) => {
      const timeout = buildAgentRunTerminalOutcome({
        status: "timeout",
        timeoutPhase: "provider",
        endedAt: 200,
      });
      const superseded = buildAgentRunTerminalOutcome({
        status: "error",
        stopReason: "superseded",
        endedAt: supersededAt,
      });
      for (const [current, incoming] of [
        [timeout, superseded],
        [superseded, timeout],
      ] as const) {
        expect(mergeAgentRunTerminalOutcome(current, incoming).reason).toBe(expected);
      }
    },
  );
});

describe("agent run attempt terminal", () => {
  it.each([
    {
      label: "external abort",
      terminal: { kind: "aborted", source: "external" } as const,
      expected: { aborted: true, externalAbort: true, timedOut: false, interrupted: true },
    },
    {
      label: "run-budget timeout",
      terminal: { kind: "timeout", phase: "prompt", source: "run_budget", aborted: true } as const,
      expected: {
        aborted: true,
        externalAbort: false,
        timedOut: true,
        timedOutByRunBudget: true,
        interrupted: true,
      },
    },
    {
      label: "compaction observation",
      terminal: { kind: "timeout", phase: "compaction", source: "observation" } as const,
      expected: {
        aborted: false,
        externalAbort: false,
        timedOut: false,
        timedOutDuringCompaction: true,
        interrupted: false,
      },
    },
    {
      label: "tool-execution observation",
      terminal: { kind: "timeout", phase: "tool_execution", source: "observation" } as const,
      expected: {
        aborted: false,
        externalAbort: false,
        timedOut: false,
        timedOutDuringToolExecution: true,
        interrupted: false,
      },
    },
  ])("preserves the exact public projection for $label", ({ terminal, expected }) => {
    expect(projectAgentRunAttemptTerminal(terminal)).toMatchObject(expected);
  });

  it("merges observation-only timeout phases without creating a run timeout", () => {
    const toolExecution = {
      kind: "timeout",
      phase: "tool_execution",
      source: "observation",
    } as const;
    const compaction = { kind: "timeout", phase: "compaction", source: "observation" } as const;

    for (const [current, incoming] of [
      [toolExecution, compaction],
      [compaction, toolExecution],
    ] as const) {
      const terminal = mergeAgentRunAttemptTerminal(current, incoming);
      expect(terminal).toEqual(compaction);
      expect(projectAgentRunAttemptTerminal(terminal).timedOut).toBe(false);
    }
  });

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
