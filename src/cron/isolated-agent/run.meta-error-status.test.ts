import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import { loadRunCronIsolatedAgentTurn, runWithModelFallbackMock } from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn - meta.error status propagation", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("marks a run-level error with empty payloads as a cron error", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        meta: {
          error: { kind: "provider_error", message: "model provider unreachable" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: model provider unreachable");
    expect(result.outputText).toBe("cron isolated run failed: model provider unreachable");
  });

  it("does not deliver partial success text when a run-level error is present", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "Partial success-looking text" }],
        meta: {
          error: { kind: "retry_limit", message: "retry limit exceeded" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: retry limit exceeded");
    expect(result.outputText).toBe("cron isolated run failed: retry limit exceeded");
  });
});
