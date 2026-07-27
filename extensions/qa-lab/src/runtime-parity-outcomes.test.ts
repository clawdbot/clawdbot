// Qa Lab tests cover runtime parity outcome precedence and skip preservation.
import { describe, expect, it } from "vitest";
import {
  captureRuntimeParityCell,
  isRuntimeParityResultPass,
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
} from "./runtime-parity.js";

function makeRuntimeParityCell(runtime: RuntimeId): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"message":{"role":"assistant","content":"done"}}\n',
    toolCalls: [],
    finalText: "done",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
    wallClockMs: 10,
    bootStateLines: [],
  };
}

describe("runtime parity outcomes", () => {
  it("keeps a skip diagnostic out of runtime error classification", async () => {
    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot: `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}`,
      },
      scenarioResult: {
        status: "skip",
        details: "expected-unavailable tool: this fixture is report-only",
      },
      wallClockMs: 10,
    });

    expect(cell.runtimeErrorClass).toBeUndefined();
  });

  it("does not claim both canonical runtime-pair cells failed for a one-sided failure", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "one-sided-cell-failure",
      runCell: async (runtime) => ({
        status: "pass",
        cell: {
          ...makeRuntimeParityCell(runtime),
          ...(runtime === "codex" ? { runtimeErrorClass: "scenario-failure" } : {}),
        },
      }),
    });

    expect(result).toMatchObject({
      drift: "failure-mode",
      driftDetails: "at least one runtime failed",
    });
  });

  it("preserves skipped cell outcomes instead of promoting matching empty evidence", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "skipped-cells",
      runCell: async (runtime) => ({
        status: "skip",
        details: "implementation unavailable",
        cell: makeRuntimeParityCell(runtime),
      }),
    });

    expect(result).toMatchObject({
      cells: {
        openclaw: { status: "skip", details: "implementation unavailable" },
        codex: { status: "skip", details: "implementation unavailable" },
      },
      drift: "failure-mode",
      driftDetails: "both canonical runtime-pair cells skipped",
    });
    expect(isRuntimeParityResultPass(result)).toBe(false);
  });

  it("requires every canonical runtime-pair cell status to pass", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "complete-result-cells",
      runCell: async (runtime) => ({
        status: "pass",
        cell: makeRuntimeParityCell(runtime),
      }),
    });

    expect(isRuntimeParityResultPass(result)).toBe(true);

    expect(
      isRuntimeParityResultPass({
        ...result,
        cells: {
          ...result.cells,
          codex: { ...result.cells.codex, status: "skip" },
        },
      }),
    ).toBe(false);

    expect(
      isRuntimeParityResultPass({
        ...result,
        cells: { openclaw: result.cells.openclaw } as typeof result.cells,
      }),
    ).toBe(false);
  });
});
