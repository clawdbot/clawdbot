// Run meta error tests cover status reporting when cron run metadata fails.
import { describe, expect, it } from "vitest";
import { CommandLaneTaskTimeoutError } from "../../process/command-queue.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  cleanupDirectCronSessionMock,
  loadRunCronIsolatedAgentTurn,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

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

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

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

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated run failed: retry limit exceeded");
    expect(result.outputText).toBe("cron isolated run failed: retry limit exceeded");
  });

  it("marks an aborted embedded agent run without a run-level error as a cron error", async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [],
        meta: {
          aborted: true,
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({ deleteAfterRun: true }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron isolated agent run aborted");
    expect(cleanupDirectCronSessionMock).toHaveBeenCalledWith({
      job: expect.objectContaining({ deleteAfterRun: true }),
      agentSessionKey: "agent:default:cron:test",
      sessionId: "test-session-id",
      lifecycleRevision: "test-lifecycle-revision",
      sessionUpdatedAt: expect.any(Number),
      beforeSessionDelete: expect.any(Function),
      retireReason: "cron-delete-after-run-aborted",
    });
  });

  it("surfaces cron timeout result when the cron-nested lane watchdog fires", async () => {
    runWithModelFallbackMock.mockRejectedValueOnce(
      new CommandLaneTaskTimeoutError("cron-nested", 330_000),
    );

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron: job execution timed out");
    expect(result.error).not.toContain("CommandLaneTaskTimeoutError");
    expect(result.error).not.toContain("cron-nested");
    // The timeout row must keep the already-resolved run attribution so
    // Task-run history does not show an un-attributed cron timeout (#95873).
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4");
    expect(result.sessionId).toBe("test-session-id");
  });

  it("keeps cron timeout result when executor rejects after the cron abort signal fires", async () => {
    const abortController = new AbortController();
    const timeoutError = new Error(
      "cron: job execution timed out (last phase: model_call_started)",
    );
    timeoutError.name = "TimeoutError";
    abortController.abort(timeoutError);
    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({ abortSignal: abortController.signal }),
      ),
    ).rejects.toBe(timeoutError);
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });
});
