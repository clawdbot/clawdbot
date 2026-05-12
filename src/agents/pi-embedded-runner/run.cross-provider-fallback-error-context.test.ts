import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  MockedFailoverError,
  mockedFormatAssistantErrorText,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
const DEEPSEEK_ERROR_MESSAGE = "429 deepseek rate limit";

function isCurrentAttemptAssistant(
  value: unknown,
): value is NonNullable<EmbeddedRunAttemptResult["currentAttemptAssistant"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    "model" in value &&
    "errorMessage" in value
  );
}

function setupDeepseekFallbackErrorMatchers() {
  mockedIsFailoverAssistantError.mockImplementation((...args: unknown[]) => {
    const assistant = args[0];
    return isCurrentAttemptAssistant(assistant) && assistant.provider === "deepseek";
  });
  mockedIsRateLimitAssistantError.mockImplementation((...args: unknown[]) => {
    const assistant = args[0];
    return isCurrentAttemptAssistant(assistant) && assistant.provider === "deepseek";
  });
}

function captureFormattedAssistant() {
  let lastFormattedAssistant: unknown;
  mockedFormatAssistantErrorText.mockImplementation((...args: unknown[]) => {
    lastFormattedAssistant = args[0];
    if (!isCurrentAttemptAssistant(lastFormattedAssistant)) {
      return String(lastFormattedAssistant);
    }
    return `${lastFormattedAssistant.provider}/${lastFormattedAssistant.model}: ${lastFormattedAssistant.errorMessage}`;
  });
  return () => lastFormattedAssistant;
}

function expectDeepseekAssistant(value: unknown) {
  if (!isCurrentAttemptAssistant(value)) {
    throw new Error(`Expected DeepSeek assistant, got ${String(value)}`);
  }
  expect(value.provider).toBe("deepseek");
  expect(value.model).toBe("deepseek-chat");
  expect(value.errorMessage).toBe(DEEPSEEK_ERROR_MESSAGE);
}

function makeCrossProviderFallbackConfig() {
  return makeModelFallbackCfg({
    agents: {
      defaults: {
        model: {
          primary: "openai-codex/gpt-5.4",
          fallbacks: ["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
        },
      },
    },
  });
}

async function expectDeepseekFallbackError(
  promise: Promise<unknown>,
  getLastFormattedAssistant: () => unknown,
) {
  await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
  await expect(promise).rejects.toThrow(`deepseek/deepseek-chat: ${DEEPSEEK_ERROR_MESSAGE}`);
  expect(mockedIsRateLimitAssistantError).toHaveBeenCalledTimes(1);
  const rateLimitCalls = mockedIsRateLimitAssistantError.mock.calls as unknown[][];
  expectDeepseekAssistant(rateLimitCalls.at(-1)?.[0]);
  expectDeepseekAssistant(getLastFormattedAssistant());
}

describe("runEmbeddedPiAgent cross-provider fallback error handling", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("uses the current attempt assistant for fallback errors instead of stale session history", async () => {
    setupDeepseekFallbackErrorMatchers();
    const getLastFormattedAssistant = captureFormattedAssistant();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: "You have hit your ChatGPT usage limit (plus plan).",
          provider: "openai-codex",
          model: "gpt-5.4",
          content: [],
        }),
        currentAttemptAssistant: makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: DEEPSEEK_ERROR_MESSAGE,
          provider: "deepseek",
          model: "deepseek-chat",
          content: [],
        }),
      }),
    );

    const promise = runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-cross-provider-fallback-error-context",
      config: makeCrossProviderFallbackConfig(),
    });

    await expectDeepseekFallbackError(promise, getLastFormattedAssistant);
  });

  it("falls back to the session assistant when compaction removes the current attempt slice", async () => {
    setupDeepseekFallbackErrorMatchers();
    const getLastFormattedAssistant = captureFormattedAssistant();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: DEEPSEEK_ERROR_MESSAGE,
          provider: "deepseek",
          model: "deepseek-chat",
          content: [],
        }),
        currentAttemptAssistant: undefined,
      }),
    );

    const promise = runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-compaction-fallback-error-context",
      config: makeCrossProviderFallbackConfig(),
    });

    await expectDeepseekFallbackError(promise, getLastFormattedAssistant);
  });
});
