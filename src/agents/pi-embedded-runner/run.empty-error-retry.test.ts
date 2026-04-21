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

// Regression coverage for the silent-error retry in runEmbeddedPiAgent.
//
// Symptom: ollama/glm-5.1 occasionally ends a turn with stopReason="error" and
// zero output tokens after a successful tool-call sequence. The user sees no
// reply and has to nudge. The existing empty-response retry path is gated on
// the strict-agentic contract (gpt-5 only), so non-frontier models fell
// through to "incomplete turn detected". This suite locks in a narrower,
// model-agnostic resubmission.

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

function emptyErrorAttempt(
  provider: string,
  model: string,
  outputTokens = 0,
): EmbeddedRunAttemptResult {
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

describe("runEmbeddedPiAgent silent-error retry", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("retries when a turn ends with stopReason=error and zero output tokens", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(emptyErrorAttempt("ollama", "glm-5.1:cloud"));
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("ollama", "glm-5.1:cloud"));

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-basic",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBeFalsy();
  });

  it("caps retries at MAX_EMPTY_ERROR_RETRIES and surfaces incomplete-turn error", async () => {
    // 1 initial + 3 retries = 4 attempts, all returning empty-error.
    for (let i = 0; i < 4; i += 1) {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(emptyErrorAttempt("ollama", "glm-5.1:cloud"));
    }

    const result = await runEmbeddedPiAgent({
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

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-skip-with-output",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry when stopReason=stop and output=0 (out of scope)", async () => {
    // Clean stop with no output is a legitimate silent reply (e.g. NO_REPLY
    // token path), not a crash. This retry must not trigger there.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "stop",
          provider: "ollama",
          model: "glm-5.1:cloud",
          content: [],
          usage: { input: 100, output: 0, totalTokens: 100 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-skip-clean-stop",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries for frontier models too — the fix is model-agnostic", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt("anthropic", "claude-opus-4-7"),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-4-7"));

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4-7",
      runId: "run-empty-error-retry-frontier",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBeFalsy();
  });

  it("does not retry when the failed attempt recorded side effects", async () => {
    // If the errored turn already sent a message / added a cron / ran a
    // mutating tool whose result wasn't captured as replay-safe,
    // resubmission would duplicate those actions. Mirror the gate used by
    // the other retry resolvers (resolveEmptyResponseRetryInstruction et al.)
    // and surface the incomplete-turn error instead of retrying blind.
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

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-skip-side-effects",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });
});
