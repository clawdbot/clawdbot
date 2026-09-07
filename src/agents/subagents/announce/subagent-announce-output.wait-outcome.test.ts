// Wait-outcome announce tests, split from subagent-announce-output.test.ts to keep
// each file under the max-lines ratchet. Same subject, same test-support shim.
import { describe, expect, it } from "vitest";
import { applySubagentWaitOutcome } from "./subagent-announce-output.test-support.js";

describe("applySubagentWaitOutcome", () => {
  it.each([
    { endedAt: undefined, prior: undefined, expected: "still-running" },
    { endedAt: 150, prior: undefined, expected: "exited" },
    { endedAt: undefined, prior: "exited", expected: "exited" },
    { endedAt: undefined, prior: "killed", expected: "killed" },
  ] as const)(
    "preserves stop evidence (endedAt=$endedAt, prior=$prior)",
    ({ endedAt, prior, expected }) => {
      const applied = applySubagentWaitOutcome({
        wait: { status: "timeout", endedAt },
        outcome: prior ? { status: "timeout", disposition: prior } : undefined,
      });
      expect(applied.outcome).toMatchObject({ status: "timeout", disposition: expected });
    },
  );

  it("treats blocked ok wait snapshots as errors", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 150,
        livenessState: "blocked",
        error: "Context overflow: prompt too large for the model.",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "error",
      error: "Context overflow: prompt too large for the model.",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("treats abandoned ok wait snapshots as incomplete failures", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 150,
        livenessState: "abandoned",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "error",
      error: "Agent run ended before producing a complete result.",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("keeps provider hard timeouts stronger than blocked wait metadata", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "error",
        startedAt: 100,
        endedAt: 150,
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "model timed out",
      },
      outcome: undefined,
    });

    // A provider hard timeout is the run's own budget firing, so unlike a bare
    // wait timeout it does prove the child stopped.
    expect(applied.outcome).toEqual({
      status: "timeout",
      disposition: "exited",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it.each(["rpc", "superseded"] as const)(
    "keeps explicit %s cancellation distinct from timeout outcomes",
    (stopReason) => {
      const applied = applySubagentWaitOutcome({
        wait: {
          status: "timeout",
          startedAt: 100,
          endedAt: 150,
          stopReason,
        },
        outcome: undefined,
      });

      expect(applied.outcome).toEqual({
        status: "error",
        error: "subagent run terminated",
        disposition: "killed",
        startedAt: 100,
        endedAt: 150,
        elapsedMs: 50,
      });
    },
  );

  // Regression (openclaw-kkv1): a wait expiry and a dead child both arrived as
  // a bare `status: "timeout"`, so the announce layer could only report one
  // wording for both. The disposition is what keeps them apart downstream.
  it("records an unconfirmed stop when a timeout snapshot carries no terminal evidence", () => {
    const applied = applySubagentWaitOutcome({
      wait: { status: "timeout", startedAt: 100 },
      outcome: undefined,
    });

    expect(applied.outcome?.status).toBe("timeout");
    expect(applied.outcome?.disposition).toBe("still-running");
  });

  it.each([
    { wait: { status: "timeout" }, expected: "still-running" },
    { wait: { status: "timeout", endedAt: 175 }, expected: "exited" },
    { wait: { status: "timeout", stopReason: "timeout" }, expected: "exited" },
  ])(
    "distinguishes retained provisional timing from fresh wait evidence: $expected",
    ({ wait, expected }) => {
      // Old persisted rows called the wait deadline endedAt. Replaying that
      // timestamp is not a child stop; a new terminal wait snapshot is.
      const applied = applySubagentWaitOutcome({
        wait,
        startedAt: 100,
        endedAt: 150,
        outcome: {
          status: "timeout",
          timeoutDisposition: "child-unconfirmed",
          startedAt: 100,
          endedAt: 150,
        },
      });
      expect(applied.outcome?.disposition).toBe(expected);
      expect(applied.outcome?.timeoutDisposition).toBeUndefined();
    },
  );

  it("records an observed stop when a timeout snapshot carries terminal evidence", () => {
    const applied = applySubagentWaitOutcome({
      wait: { status: "timeout", startedAt: 100, endedAt: 150 },
      outcome: undefined,
    });

    expect(applied.outcome?.status).toBe("timeout");
    expect(applied.outcome?.disposition).toBe("exited");
  });

  it("does not downgrade an already-observed stop when a later wait expiry has no evidence", () => {
    const applied = applySubagentWaitOutcome({
      wait: { status: "timeout" },
      outcome: { status: "timeout", timeoutDisposition: "child-stopped" },
    });

    expect(applied.outcome?.disposition).toBe("exited");
  });

  it("treats aborted ok wait snapshots as terminated subagent errors", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 150,
        stopReason: "aborted",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "error",
      error: "subagent run terminated",
      disposition: "killed",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it.each(["restart", "aborted"] as const)(
    "keeps %s stop reasons as cancellation even when liveness is blocked",
    (stopReason) => {
      // classifySubagentTerminalOutcome must win over the generic classifier
      // here: blocked liveness alone would read as a failure, but an explicit
      // restart/aborted stop reason owns the outcome (openclaw#125407).
      const applied = applySubagentWaitOutcome({
        wait: {
          status: "ok",
          startedAt: 100,
          endedAt: 150,
          stopReason,
          livenessState: "blocked",
          error: "Context overflow: prompt too large for the model.",
        },
        outcome: undefined,
      });

      expect(applied.outcome).toEqual({
        status: "error",
        error: "subagent run terminated",
        disposition: "killed",
        startedAt: 100,
        endedAt: 150,
        elapsedMs: 50,
      });
    },
  );

  it("keeps the failure cause on pending-error timeout wait snapshots", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "timeout",
        startedAt: 100,
        endedAt: 150,
        pendingError: true,
        error: "model returned an unrecoverable tool-call sequence",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      error: "model returned an unrecoverable tool-call sequence",
      disposition: "exited",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("leaves genuine budget timeouts without a cause", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "timeout",
        startedAt: 100,
        endedAt: 150,
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      disposition: "exited",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("ignores wait error text when the run did not end in a pending error", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "timeout",
        startedAt: 100,
        endedAt: 150,
        error: "waited too long",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      disposition: "exited",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });
});
