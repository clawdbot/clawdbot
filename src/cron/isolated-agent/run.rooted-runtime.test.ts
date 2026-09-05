// Rooted cron runtime tests cover fallback candidates that cannot use the CLI runtime.
import { describe, expect, it } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  resolveEffectiveAgentRuntimeMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const executionRoot = "/tmp/workshop-skills";

describe("runCronIsolatedAgentTurn — rooted runtime fallback", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([
    { prompt: "", skills: [] },
    { prompt: "Explicit safe instructions", skills: [{ name: "safe" }] },
  ])("preserves the host-selected instruction snapshot: $prompt", async (skillsSnapshot) => {
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot, skillsSnapshot }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(expect.objectContaining({ skillsSnapshot }));
  });

  it("rejects all-CLI fallbacks after a rooted embedded candidate fails", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ modelId }: { modelId: string }) =>
      modelId === "gpt-5.4" ? "openclaw" : "claude-cli",
    );
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runEmbeddedAgentMock.mockRejectedValueOnce(new Error("embedded primary failed"));
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow(
        "embedded primary failed",
      );
      const result = await runFallbackModelAttempt(
        params,
        "claude-cli",
        "claude-opus-4-6",
        "unknown",
      );
      return { result, provider: "claude-cli", model: "claude-opus-4-6", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot }),
    );

    expect(result).toMatchObject({
      status: "error",
      admissionDisposition: "rejected",
      error:
        "collection review requires the embedded agent runtime; the configured CLI runtime cannot be rooted at the Workshop directory",
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("skips a rooted CLI fallback and reaches a later embedded candidate", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ modelId }: { modelId: string }) =>
      modelId === "gpt-5.4" || modelId === "gpt-5" ? "openclaw" : "claude-cli",
    );
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runEmbeddedAgentMock.mockImplementation(
      async (params: { model?: string; onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        if (params.model === "gpt-5.4") {
          throw new Error("embedded primary failed");
        }
        return { payloads: [{ text: "later embedded succeeded" }], meta: { agentMeta: {} } };
      },
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow(
        "embedded primary failed",
      );
      await expect(
        runFallbackModelAttempt(params, "claude-cli", "claude-opus-4-6", "unknown"),
      ).rejects.toThrow("collection review requires the embedded agent runtime");
      const result = await runFallbackModelAttempt(params, "openai", "gpt-5", "unknown");
      return { result, provider: "openai", model: "gpt-5", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ provider: "openai", model: "gpt-5" }),
    );
  });
});
