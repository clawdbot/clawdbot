// QA Lab tests cover canonical runtime-pair result projection.
import { describe, expect, it } from "vitest";
import { buildRuntimeParityScenarioResult } from "./suite-runtime-parity-result.js";

function makeCell(
  runtime: "openclaw" | "codex",
  status: "pass" | "fail" | "skip",
  runtimeErrorClass?: string,
) {
  return {
    runtime,
    status,
    transcriptBytes: "",
    toolCalls: [],
    finalText: "",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    wallClockMs: 1,
    bootStateLines: [],
    ...(runtimeErrorClass ? { runtimeErrorClass } : {}),
  };
}

describe("QA suite runtime parity result projection", () => {
  it("combines result-cell status with execution errors without losing skip details", () => {
    const failed = buildRuntimeParityScenarioResult({
      scenarioName: "Runtime tool fixture — read",
      result: {
        scenarioId: "runtime-tool-read",
        cells: {
          openclaw: {
            ...makeCell("openclaw", "skip"),
            details:
              "implementation unavailable\nRUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
          },
          codex: makeCell("codex", "pass", "scenario-failure"),
        },
        drift: "none",
      },
    });
    expect(failed.status).toBe("fail");
    expect(failed.steps?.map((step) => step.status)).toEqual(["skip", "fail", "fail"]);
    expect(failed.steps?.[0]?.details).toContain(
      "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
    );

    const skipped = buildRuntimeParityScenarioResult({
      scenarioName: "Runtime tool fixture — read",
      result: {
        scenarioId: "runtime-tool-read",
        cells: {
          openclaw: makeCell("openclaw", "skip"),
          codex: makeCell("codex", "skip"),
        },
        drift: "failure-mode",
      },
    });
    expect(skipped.status).toBe("skip");
    expect(skipped.steps?.map((step) => step.status)).toEqual(["skip", "skip", "skip"]);
  });

  it("passes an explicitly known one-sided harness gap while preserving its skipped cell", () => {
    const result = buildRuntimeParityScenarioResult({
      scenarioName: "Runtime tool fixture — exec",
      result: {
        scenarioId: "runtime-tool-exec",
        cells: {
          openclaw: makeCell("openclaw", "pass"),
          codex: {
            ...makeCell("codex", "skip"),
            details:
              "known-harness-gap exec: Codex owns command execution natively\ntracking: #80319",
          },
        },
        drift: "structural",
        driftDetails: "known harness gap in codex runtime; paired runtime passed",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.steps?.map((step) => step.status)).toEqual(["pass", "skip", "pass"]);
    expect(result.steps?.[1]?.details).toContain("known-harness-gap exec");
  });
});
