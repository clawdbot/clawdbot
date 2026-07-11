// Coverage for handing replay-safe plugin-harness prompt timeouts to model fallback.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent prompt timeout fallback handoff", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    useOpenAIPlatformAuthFixture();
  });

  it("throws FailoverError for replay-safe harness-owned prompt timeouts when model fallbacks are configured", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("LLM request timed out."),
        promptErrorSource: "prompt",
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

  it("surfaces replay-invalid prompt timeouts instead of handing them to model fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("LLM request timed out."),
        promptErrorSource: "prompt",
        promptTimeoutOutcome: {
          message: "Harness abandoned the timed-out turn after provider activity.",
          replayInvalid: true,
          livenessState: "abandoned",
        },
      }),
    );

    let thrown: unknown;
    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        runId: "run-prompt-timeout-replay-invalid",
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
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(MockedFailoverError);
    expect(String((thrown as Error | undefined)?.message)).toContain("LLM request timed out.");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
