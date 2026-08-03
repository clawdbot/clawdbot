// Full-entry coverage for handing replay-safe prompt timeouts to model fallback.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent prompt timeout fallback handoff", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    useOpenAIPlatformAuthFixture();
  });

  it("throws FailoverError for replay-safe harness-owned prompt timeouts when model fallbacks are configured", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        terminal: {
          kind: "failed",
          source: "prompt",
          error: new Error("LLM request timed out."),
        },
      }),
    );

    const promise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-prompt-timeout-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
