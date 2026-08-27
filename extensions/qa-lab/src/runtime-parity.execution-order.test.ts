// QA Lab tests cover requested runtime execution order and canonical result identity.
import { describe, expect, it, vi } from "vitest";
import {
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
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    wallClockMs: 10,
    bootStateLines: [],
  };
}

describe("runtime parity execution order", () => {
  it.each([
    {
      label: "the canonical default",
      runtimePair: undefined,
      expectedExecutionOrder: ["openclaw", "codex"],
    },
    {
      label: "an explicitly canonical pair",
      runtimePair: ["openclaw", "codex"],
      expectedExecutionOrder: ["openclaw", "codex"],
    },
    {
      label: "a reversed pair",
      runtimePair: ["codex", "openclaw"],
      expectedExecutionOrder: ["codex", "openclaw"],
    },
  ] satisfies Array<{
    label: string;
    runtimePair: [RuntimeId, RuntimeId] | undefined;
    expectedExecutionOrder: [RuntimeId, RuntimeId];
  }>)(
    "runs $label in its requested order with canonical result cells",
    async ({ runtimePair, expectedExecutionOrder }) => {
      const runCell = vi.fn(async (runtime: RuntimeId) => ({
        status: "pass" as const,
        cell: makeRuntimeParityCell(runtime),
      }));
      const result = await runRuntimeParityScenario({
        scenarioId: "runtime-execution-order",
        ...(runtimePair ? { runtimePair } : {}),
        runCell,
      });

      expect(runCell.mock.calls.map(([runtime]) => runtime)).toEqual(expectedExecutionOrder);
      expect(Object.keys(result.cells)).toEqual(["openclaw", "codex"]);
      expect(result.cells.openclaw).toMatchObject({ runtime: "openclaw", status: "pass" });
      expect(result.cells.codex).toMatchObject({ runtime: "codex", status: "pass" });
      expect(result.drift).toBe("none");
    },
  );

  it.each(["openclaw", "codex"] as const)(
    "rejects duplicate %s runtimes before executing a parity cell",
    async (runtime) => {
      const runCell = vi.fn(async (selectedRuntime: RuntimeId) => ({
        status: "pass" as const,
        cell: makeRuntimeParityCell(selectedRuntime),
      }));

      await expect(
        runRuntimeParityScenario({
          scenarioId: "duplicate-runtime-pair",
          runtimePair: [runtime, runtime],
          runCell,
        }),
      ).rejects.toThrow(/different|distinct|duplicate/i);
      expect(runCell).not.toHaveBeenCalled();
    },
  );

  it("attributes a failed reversed pair to its canonical runtime cell", async () => {
    const executionOrder: RuntimeId[] = [];
    const result = await runRuntimeParityScenario({
      scenarioId: "reversed-runtime-cell-failure",
      runtimePair: ["codex", "openclaw"],
      runCell: async (runtime) => {
        executionOrder.push(runtime);
        return {
          status: runtime === "codex" ? ("fail" as const) : ("pass" as const),
          ...(runtime === "codex" ? { details: "Codex scenario failed" } : {}),
          cell: makeRuntimeParityCell(runtime),
        };
      },
    });

    expect(executionOrder).toEqual(["codex", "openclaw"]);
    expect(result.cells.openclaw.status).toBe("pass");
    expect(result.cells.codex).toMatchObject({
      runtime: "codex",
      status: "fail",
      details: "Codex scenario failed",
    });
    expect(result).toMatchObject({
      drift: "failure-mode",
      driftDetails: "runtime-pair cell status differs (pass vs fail)",
    });
    expect(isRuntimeParityResultPass(result)).toBe(false);
  });
});
