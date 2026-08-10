import { describe, expect, it } from "vitest";
import {
  drainCodeModeAttemptStats,
  ensureCodeModeStats,
  recordCodeModeBridgeRegistered,
  recordCodeModeBridgeSettled,
  recordCodeModeBridgeStarted,
  recordCodeModeControlCall,
  recordCodeModeWorkerRun,
  registerCodeModeStatsSource,
} from "../code-mode-stats.js";
import { createRunAccountingAccumulator } from "./run-accounting.js";

describe("command run accounting Code Mode deltas", () => {
  it("aggregates parked-run lifecycle deltas without double-counting the live gauge", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");

    const firstOwner = { current: {} };
    const source = ensureCodeModeStats(firstOwner);
    if (!source) {
      throw new Error("expected first Code Mode stats owner");
    }
    recordCodeModeControlCall(source, "exec");
    recordCodeModeWorkerRun(source, "exec", 4);
    recordCodeModeBridgeRegistered(source, "callValue");
    recordCodeModeBridgeStarted(source);
    const firstAttempt = drainCodeModeAttemptStats(firstOwner);
    if (!firstAttempt) {
      throw new Error("expected first Code Mode attempt delta");
    }
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeStats: firstAttempt,
      codeModeLifecycleObserved: true,
    });

    const resumedOwner = { current: {} };
    registerCodeModeStatsSource(resumedOwner, source);
    recordCodeModeControlCall(source, "wait");
    recordCodeModeWorkerRun(source, "resume", 3);
    recordCodeModeBridgeSettled(source, { failed: false, settledAfterCancel: false });
    const resumedAttempt = drainCodeModeAttemptStats(resumedOwner);
    if (!resumedAttempt) {
      throw new Error("expected resumed Code Mode attempt delta");
    }
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeStats: resumedAttempt,
      codeModeLifecycleObserved: true,
    });
    candidate.settle("returned");

    const codeMode = accounting.project().codeMode;
    expect(codeMode?.stats).toMatchObject({
      controlCalls: { exec: 1, wait: 1 },
      workerRuns: {
        exec: { count: 1, elapsedMs: 4 },
        resume: { count: 1, elapsedMs: 3 },
      },
      bridgeLifecycle: { registered: 1, started: 1, settled: 1 },
    });
    expect(codeMode?.stats?.bridgeLifecycle).not.toHaveProperty("unresolvedAtExtraction");
    expect(codeMode?.lifecycle).toEqual({
      maxUnresolvedAtExtraction: 1,
      attemptsWithUnresolved: 1,
      finalQuiescence: { state: "unavailable", reasons: ["not_observed"] },
    });
  });
});
