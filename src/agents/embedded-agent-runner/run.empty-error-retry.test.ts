// Coverage for retrying empty errored assistant turns in runEmbeddedAgent.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function emptyErrorAttempt(
  provider: string,
  model: string,
  outputTokens = 0,
): EmbeddedRunAttemptResult {
  // Models can report stopReason=error with no output after tool activity; that
  // is replay-safe only when the attempt metadata records no side effects.
  return makeAttemptResult({
    assistantTexts: [],
    lastAssistant: {
      stopReason: "error",
      provider,
      model,
      content: [],
      usage: { input: 100, output: outputTokens, totalTokens: 100 + outputTokens },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

function successAttempt(provider: string, model: string): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: ["Done."],
    lastAssistant: {
      stopReason: "stop",
      provider,
      model,
      content: [{ type: "text", text: "Done." }],
      usage: { input: 100, output: 5, totalTokens: 105 },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

describe("runEmbeddedAgent silent-error retry", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("retries when a turn ends with stopReason=error and zero output tokens", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(emptyErrorAttempt("ollama", "glm-5.1:cloud"));
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("ollama", "glm-5.1:cloud"));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-basic",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("caps retries at MAX_EMPTY_ERROR_RETRIES and surfaces incomplete-turn error", async () => {
    // 1 initial + 3 retries = 4 attempts, all returning empty-error.
    for (let i = 0; i < 4; i += 1) {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(emptyErrorAttempt("ollama", "glm-5.1:cloud"));
    }

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("does not retry when stopReason=error but output tokens > 0", async () => {
    // Model produced something before erroring; surfacing that text is better
    // than silent resubmission.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt("ollama", "glm-5.1:cloud", 12),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-skip-with-output",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry when stopReason=stop and output=0 (out of scope)", async () => {
    // Clean stop with no output is a legitimate silent reply (e.g. NO_REPLY
    // token path), not a crash. Use a plain provider/model so this test stays
    // scoped to the silent-error retry instead of the empty-response retry.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "stop",
          provider: "plain-provider",
          model: "plain-model",
          content: [],
          usage: { input: 100, output: 0, totalTokens: 100 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "plain-provider",
      model: "plain-model",
      runId: "run-empty-error-retry-skip-clean-stop",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries for frontier models too — the fix is model-agnostic", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt("anthropic", "claude-opus-4-7"),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-4-7"));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4-7",
      runId: "run-empty-error-retry-frontier",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("does not retry when the failed attempt recorded side effects", async () => {
    // Resubmission would duplicate side effects when replay metadata cannot
    // prove the failed turn is safe to replay.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "error",
          provider: "ollama",
          model: "glm-5.1:cloud",
          content: [],
          usage: { input: 100, output: 0, totalTokens: 100 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        replayMetadata: {
          hadPotentialSideEffects: true,
          replaySafe: false,
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-skip-side-effects",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });
});
