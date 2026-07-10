// Qa Lab tests cover runtime parity classification behavior.
import { describe, expect, it } from "vitest";
import {
  __testing,
  captureRuntimeParityCell,
  isRuntimeParityResultPass,
  resolveRuntimeParityUsagePolicy,
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
  it("keeps a retry pass diagnostic from failing the captured cell", async () => {
    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: {
        tempRoot: `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}`,
      },
      scenarioResult: {
        status: "pass",
        details: "ok | passed on retry; first attempt: timed out after 20000ms",
      },
      wallClockMs: 10,
    });

    expect(cell.runtimeErrorClass).toBeUndefined();
  });

  it("still classifies terminal scenario failure diagnostics", async () => {
    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: {
        tempRoot: `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}`,
      },
      scenarioResult: {
        status: "fail",
        details: "timed out after 20000ms",
      },
      wallClockMs: 10,
    });

    expect(cell.runtimeErrorClass).toBe("timeout");
  });

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
    expect(result.runtimeParityUsage).toEqual({
      expectation: "assistant-message-required",
    });
  });

  it("preserves explicit usage-not-applicable metadata on parity results", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "local-fixture",
      runtimeParityUsage: {
        expectation: "not-applicable",
        reason: " Local fixture only; no assistant turn runs. ",
      },
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeRuntimeParityCell(runtime, []),
      }),
    });

    expect(result.runtimeParityUsage).toEqual({
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    });
  });

  it("defaults malformed usage metadata to assistant-message-required", () => {
    expect(resolveRuntimeParityUsagePolicy({ expectation: "not-applicable" })).toEqual({
      expectation: "assistant-message-required",
    });
    expect(
      resolveRuntimeParityUsagePolicy({ expectation: "not-applicable", reason: "   " }),
    ).toEqual({ expectation: "assistant-message-required" });
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

  it("treats matching controlled tool errors as equivalent results", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "matching-tool-errors",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: {
          ...makeRuntimeParityCell(runtime, [
            {
              tool: "web_search",
              argsHash: "same-args",
              resultHash: runtime === "openclaw" ? "validation-error" : "provider-error",
              errorClass: "tool-result-error",
            },
          ]),
          ...(runtime === "codex" ? { runtimeErrorClass: "tool-error" } : {}),
        },
      }),
    });

    expect(result.drift).toBe("none");
    expect(isRuntimeParityResultPass(result)).toBe(true);
  });

  it("does not mask runtime cell scenario failures behind drift", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "failed-cell-with-drift",
      runCell: async (runtime) => ({
        scenarioStatus: runtime === "codex" ? "fail" : "pass",
        cell: makeRuntimeParityCell(runtime, [
          {
            tool: "web_search",
            argsHash: "same-args",
            resultHash: runtime === "codex" ? "failed-result" : "ok-result",
          },
        ]),
      }),
    });

    expect(result).toMatchObject({
      drift: "failure-mode",
      driftDetails: "scenario status differs (pass vs fail)",
    });
    expect(isRuntimeParityResultPass(result)).toBe(false);
  });

  it("prefers transcript tool results when mock debug rows are incomplete", () => {
    const resolved = __testing.resolveRuntimeParityToolCalls({
      mockToolCalls: [
        {
          tool: "image_generate",
          argsHash: "same-args",
          resultHash: "missing",
          errorClass: "tool-result-missing",
        },
      ],
      transcriptToolCalls: [
        {
          tool: "image_generate",
          argsHash: "same-args",
          resultHash: "async-started",
        },
      ],
    });

    expect(resolved).toEqual([
      {
        tool: "image_generate",
        argsHash: "same-args",
        resultHash: "async-started",
      },
    ]);
  });

  it("scopes process-global mock requests to the parent session prompt", () => {
    const scoped = __testing.filterMockRequestsForParentPrompt(
      [
        {
          prompt: "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
          allInputText:
            "Delegate one bounded QA task to a subagent. Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
          plannedToolName: "read",
        },
        {
          prompt: "Delegate one bounded QA task to a subagent.",
          allInputText: "Delegate one bounded QA task to a subagent.",
          plannedToolName: "sessions_spawn",
        },
        {
          prompt: "Continue the bounded QA task with the retained child result.",
          allInputText:
            "Delegate one bounded QA task to a subagent. Continue the bounded QA task with the retained child result.",
          plannedToolName: "sessions_spawn",
        },
        {
          allInputText: "Inspect the QA workspace and return one concise protocol note.",
          plannedToolName: "read",
        },
        {
          prompt: "Delegate one bounded QA task to a subagent.",
          allInputText: "Delegate one bounded QA task to a subagent. Tool result: child accepted.",
          toolOutput: "child accepted",
        },
      ],
      "Delegate one bounded QA task to a subagent.",
      [
        "Delegate one bounded QA task to a subagent.",
        "Continue the bounded QA task with the retained child result.",
      ],
    );

    expect(scoped).toHaveLength(3);
    expect(scoped.map((request) => request.plannedToolName ?? "result")).toEqual([
      "sessions_spawn",
      "sessions_spawn",
      "result",
    ]);
  });
});
