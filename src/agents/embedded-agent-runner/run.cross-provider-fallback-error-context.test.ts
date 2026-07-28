// Coverage for preserving current-attempt error context across model fallback.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedFormatAssistantErrorText,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  mockedResolveAuthProfileOrder,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;
const DEEPSEEK_ERROR_MESSAGE = "429 insufficient quota";
const COMPACTION_REMOVED_ERROR_MESSAGE = "current candidate model unavailable";
type CurrentAttemptAssistantWithError = NonNullable<
  EmbeddedRunAttemptResult["currentAttemptAssistant"]
> & { errorMessage: string };

function isCurrentAttemptAssistant(value: unknown): value is CurrentAttemptAssistantWithError {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    "model" in value &&
    "errorMessage" in value &&
    typeof value.errorMessage === "string"
  );
}

function setupDeepseekFallbackErrorMatchers() {
  // DeepSeek matchers prove failover classification uses the current candidate
  // assistant instead of stale history from the previous provider.
  mockedIsFailoverAssistantError.mockImplementation((...args: unknown[]) => {
    const assistant = args[0];
    return isCurrentAttemptAssistant(assistant) && assistant.provider === "deepseek";
  });
  mockedIsRateLimitAssistantError.mockImplementation((...args: unknown[]) => {
    const assistant = args[0];
    return isCurrentAttemptAssistant(assistant) && assistant.provider === "deepseek";
  });
  mockedClassifyFailoverReason.mockReturnValue("rate_limit");
}

function captureFormattedAssistant() {
  // Capture the assistant passed to formatting so tests can inspect which
  // provider/model error object drove the final failover message.
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
          primary: "openai/gpt-5.4",
          fallbacks: ["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
        },
      },
    },
  });
}

function useCrossProviderAuthFixture() {
  const store = {
    version: 1 as const,
    profiles: {
      "anthropic:test": {
        type: "api_key" as const,
        provider: "anthropic",
        key: "anthropic-test-key",
      },
      "deepseek:test": {
        type: "api_key" as const,
        provider: "deepseek",
        key: "deepseek-test-key",
      },
    },
  };
  mockedEnsureAuthProfileStore.mockReturnValue(store);
  mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(store);
  mockedResolveAuthProfileOrder.mockImplementation((params?: unknown) => {
    const provider = (params as { provider?: string } | undefined)?.provider;
    return provider && `${provider}:test` in store.profiles ? [`${provider}:test`] : [];
  });
}

function setupCompactionRemovedFallbackAttempt() {
  mockedIsFailoverAssistantError.mockImplementation((...args: unknown[]) => {
    const assistant = args[0];
    return isCurrentAttemptAssistant(assistant) && assistant.provider === "anthropic";
  });
  mockedClassifyFailoverReason.mockReturnValue("model_not_found");
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({
      assistantTexts: [],
      lastAssistant: makeAssistantMessageFixture({
        stopReason: "error",
        errorMessage: COMPACTION_REMOVED_ERROR_MESSAGE,
        provider: "anthropic",
        model: "test-model",
        content: [],
      }),
      currentAttemptAssistant: undefined,
    }),
  );
}

function runCompactionRemovedFallbackAttempt() {
  return runEmbeddedAgent({
    ...overflowBaseRunParams,
    runId: "run-compaction-fallback-error-context",
    config: makeCrossProviderFallbackConfig(),
    agentHarnessRuntimeOverride: "openclaw",
    provider: "anthropic",
    model: "test-model",
    authProfileId: "anthropic:test",
    authProfileIdSource: "user",
    modelFallbacksOverride: ["deepseek/deepseek-chat"],
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

describe("runEmbeddedAgent cross-provider fallback error handling", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent, {
      config: makeCrossProviderFallbackConfig(),
      agentHarnessRuntimeOverride: "openclaw",
      provider: "deepseek",
      model: "deepseek-chat",
    });
    setupCompactionRemovedFallbackAttempt();
    await runCompactionRemovedFallbackAttempt().catch(() => undefined);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    useCrossProviderAuthFixture();
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
          provider: "openai",
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

    const promise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-cross-provider-fallback-error-context",
      config: makeCrossProviderFallbackConfig(),
      agentHarnessRuntimeOverride: "openclaw",
      provider: "deepseek",
      model: "deepseek-chat",
      authProfileId: "deepseek:test",
      authProfileIdSource: "user",
      modelFallbacksOverride: ["deepseek/deepseek-chat"],
    });

    await expectDeepseekFallbackError(promise, getLastFormattedAssistant);
  });

  it("falls back to the session assistant when compaction removes the current attempt slice", async () => {
    const getLastFormattedAssistant = captureFormattedAssistant();
    setupCompactionRemovedFallbackAttempt();
    const promise = runCompactionRemovedFallbackAttempt();

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow(
      `anthropic/test-model: ${COMPACTION_REMOVED_ERROR_MESSAGE}`,
    );
    expect(mockedIsFailoverAssistantError).toHaveBeenCalledTimes(1);
    expect(getLastFormattedAssistant()).toMatchObject({
      provider: "anthropic",
      model: "test-model",
      errorMessage: COMPACTION_REMOVED_ERROR_MESSAGE,
    });
  });

  it("does not reuse a prior provider session assistant when the current candidate times out", async () => {
    // Timeout failover has no reliable current assistant. Reusing the previous
    // provider's session error would misattribute the failed candidate.
    const getLastFormattedAssistant = captureFormattedAssistant();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        lastAssistant: makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: "You exceeded your current OpenAI quota.",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        }),
        currentAttemptAssistant: undefined,
      }),
    );

    const promise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-stale-session-assistant-timeout",
      config: makeCrossProviderFallbackConfig(),
      agentHarnessRuntimeOverride: "openclaw",
      provider: "deepseek",
      model: "deepseek-chat",
      authProfileId: "deepseek:test",
      authProfileIdSource: "user",
      modelFallbacksOverride: ["deepseek/deepseek-chat"],
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    await expect(promise).rejects.not.toThrow("OpenAI quota");
    expect(getLastFormattedAssistant()).toBeUndefined();
  });

  it("does not reuse a prior provider session assistant for non-timeout failover", async () => {
    mockedIsFailoverAssistantError.mockImplementation((...args: unknown[]) => {
      const assistant = args[0];
      return isCurrentAttemptAssistant(assistant) && assistant.errorMessage.includes("quota");
    });
    const getLastFormattedAssistant = captureFormattedAssistant();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeAssistantMessageFixture({
          stopReason: "error",
          errorMessage: "You exceeded your current OpenAI quota.",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        }),
        currentAttemptAssistant: undefined,
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-stale-session-assistant-non-timeout",
      config: makeCrossProviderFallbackConfig(),
      agentHarnessRuntimeOverride: "openclaw",
      provider: "deepseek",
      model: "deepseek-chat",
      authProfileId: "deepseek:test",
      authProfileIdSource: "user",
      modelFallbacksOverride: ["deepseek/deepseek-chat"],
    });

    expect(mockedIsFailoverAssistantError).toHaveBeenCalledWith(undefined);
    expect(getLastFormattedAssistant()).toBeUndefined();
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.agentMeta).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });
});
