import type { QaRuntimeParitySuiteSummary } from "./agentic-parity-report.js";

export function makeRuntimeParitySummary(): QaRuntimeParitySuiteSummary {
  return {
    scenarios: [
      {
        name: "Approval turn tool followthrough",
        status: "pass",
        steps: [],
        runtimeParity: {
          scenarioId: "approval-turn-tool-followthrough",
          drift: "none",
          cells: {
            openclaw: {
              runtime: "openclaw",
              status: "pass",
              transcriptBytes: '{"role":"assistant"}\n',
              toolCalls: [{ tool: "read_file", argsHash: "a", resultHash: "r" }],
              finalText: "done",
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              wallClockMs: 20,
              bootStateLines: [],
            },
            codex: {
              runtime: "codex",
              status: "pass",
              transcriptBytes: '{"role":"assistant"}\n',
              toolCalls: [{ tool: "read_file", argsHash: "a", resultHash: "r" }],
              finalText: "done",
              usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
              wallClockMs: 18,
              bootStateLines: [],
            },
          },
        },
      },
      {
        name: "Compaction retry after mutating tool",
        status: "pass",
        steps: [],
        runtimeParity: {
          scenarioId: "compaction-retry-after-mutating-tool",
          drift: "tool-call-shape",
          driftDetails: "tool call 1 differs",
          cells: {
            openclaw: {
              runtime: "openclaw",
              status: "pass",
              transcriptBytes: '{"role":"assistant"}\n',
              toolCalls: [{ tool: "read_file", argsHash: "a", resultHash: "r" }],
              finalText: "done",
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              wallClockMs: 20,
              bootStateLines: [],
            },
            codex: {
              runtime: "codex",
              status: "pass",
              transcriptBytes: '{"role":"assistant"}\n',
              toolCalls: [{ tool: "read_file", argsHash: "b", resultHash: "r" }],
              finalText: "done",
              usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
              wallClockMs: 19,
              bootStateLines: [],
            },
          },
        },
      },
    ],
    counts: {
      total: 2,
      passed: 2,
      failed: 0,
    },
    run: {
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.6-luna",
      runtimePair: ["openclaw", "codex"],
    },
  };
}
