// Qa Lab tests cover runtime parity classification behavior.
import { describe, expect, it } from "vitest";
import {
  __testing,
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
  type RuntimeParityToolCall,
} from "./runtime-parity.js";

function makeRuntimeParityCell(
  runtime: RuntimeId,
  toolCalls: RuntimeParityToolCall[],
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"message":{"role":"assistant","content":"done"}}\n',
    toolCalls,
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

describe("runtime parity", () => {
  it("marks planned mock tool calls without outputs as missing tool results", () => {
    const toolCalls = __testing.resolveToolCallOrderFromMockRequests([
      {
        plannedToolName: "read_file",
        plannedToolArgs: { path: "README.md" },
      },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      tool: "read_file",
      errorClass: "tool-result-missing",
    });
  });

  it("keeps resolved mock tool calls eligible for no-drift parity", async () => {
    const toolCalls = __testing.resolveToolCallOrderFromMockRequests([
      {
        plannedToolName: "read_file",
        plannedToolArgs: { path: "README.md" },
      },
      {
        toolOutput: JSON.stringify({ ok: true }),
      },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.errorClass).toBeUndefined();

    const result = await runRuntimeParityScenario({
      scenarioId: "resolved-tool",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeRuntimeParityCell(runtime, toolCalls),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("classifies planned-only matching tool calls as failure-mode", async () => {
    const toolCalls = __testing.resolveToolCallOrderFromMockRequests([
      {
        plannedToolName: "read_file",
        plannedToolArgs: { path: "README.md" },
      },
    ]);

    const result = await runRuntimeParityScenario({
      scenarioId: "planned-only-tool",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeRuntimeParityCell(runtime, toolCalls),
      }),
    });

    expect(result).toMatchObject({
      drift: "failure-mode",
      driftDetails: "at least one runtime planned a tool call without a tool result",
    });
  });
});
