import { describe, expect, it } from "vitest";
import { createRunAccountingAccumulator } from "./run-accounting.js";

describe("command run accounting final quiescence", () => {
  it.each(["quiescent", "non_quiescent"] as const)(
    "projects the observed Code Mode final state as %s",
    (finalQuiescence) => {
      const accounting = createRunAccountingAccumulator();
      const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
      candidate.selectRuntime("embedded");
      candidate.observeEmbeddedAttempt({
        provider: "openai",
        model: "gpt-test",
        assistantTurnsObserved: true,
        toolsObserved: true,
        codeModeEngaged: true,
        codeModeLifecycleObserved: true,
      });
      accounting.observeCodeModeFinalQuiescence(finalQuiescence);
      candidate.settle("returned");

      expect(accounting.project().codeMode?.lifecycle.finalQuiescence).toEqual({
        state: finalQuiescence,
      });
    },
  );

  it.each(["quiescent", "non_quiescent"] as const)(
    "projects terminal-only Code Mode state as %s without attempt stats",
    (finalQuiescence) => {
      const accounting = createRunAccountingAccumulator();
      accounting.observeCodeModeFinalQuiescence(finalQuiescence);

      expect(accounting.project().codeMode).toEqual({
        engaged: true,
        lifecycle: {
          finalQuiescence: { state: finalQuiescence },
        },
      });
    },
  );

  it.each([
    { runtime: "cli", reason: "cli_runtime" },
    { runtime: "native", reason: "native_runtime" },
  ] as const)("keeps $runtime Code Mode final state unavailable", ({ runtime, reason }) => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "test", model: "test" });
    candidate.selectRuntime(runtime);
    candidate.observeEmbeddedAttempt({
      provider: "test",
      model: "test",
      assistantTurnsObserved: false,
      toolsObserved: false,
      codeModeEngaged: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project().codeMode?.lifecycle.finalQuiescence).toEqual({
      state: "unavailable",
      reasons: [reason],
    });
  });
});
