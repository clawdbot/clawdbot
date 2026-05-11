import { describe, expect, it } from "vitest";
import { CommandLaneTaskTimeoutError } from "../../process/command-queue.js";
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

  it("surfaces cron timeout result when the cron-nested lane watchdog fires", async () => {
    runWithModelFallbackMock.mockRejectedValueOnce(
      new CommandLaneTaskTimeoutError("cron-nested", 330_000),
    );

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron: job execution timed out");
    expect(result.error).not.toContain("CommandLaneTaskTimeoutError");
    expect(result.error).not.toContain("cron-nested");
  });

  it("keeps cron timeout result when executor rejects after the cron abort signal fires", async () => {
    const abortController = new AbortController();
    abortController.abort("cron: job execution timed out (last phase: model_call_started)");
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error(
        'All models failed (2): openai-codex/gpt-5.5: Command lane "cron-nested" task timed out after 330000ms (timeout)',
      ),
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({ abortSignal: abortController.signal }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron: job execution timed out (last phase: model_call_started)");
    expect(result.error).not.toContain("All models failed");
    expect(result.error).not.toContain("cron-nested");
  });
});
