import { describe, expect, it } from "vitest";
import { createCodeModeStats, recordCodeModeSnapshot } from "../agents/code-mode-stats.js";
import { classifyAgentExecResult } from "./agent-exec.js";

describe("agent exec Code Mode accounting", () => {
  it("projects detailed Code Mode stats", () => {
    const codeModeStats = createCodeModeStats();
    codeModeStats.controlCalls.exec = 2;
    codeModeStats.bridgeCalls.callValue = 3;
    recordCodeModeSnapshot(codeModeStats, {
      disposition: "rejected",
      rejectionReason: "schema",
      measurement: { bytes: 64, serializationMs: 2 },
      coverage: "exact",
    });

    const envelope = classifyAgentExecResult({
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 10,
        agentMeta: {
          sessionId: "session-result",
          provider: "openai",
          model: "gpt-5.6-sol",
          codeModeStats,
        },
        executionTrace: {
          attempts: [
            { provider: "openai", model: "gpt-5.6-sol", result: "same_model_rate_limit" },
            { provider: "openai", model: "gpt-5.6-sol", result: "fallback_model" },
            { provider: "anthropic", model: "claude-opus-5", result: "success" },
          ],
        },
      },
    });

    expect(envelope.codeModeStats).toEqual(codeModeStats);
  });
});
