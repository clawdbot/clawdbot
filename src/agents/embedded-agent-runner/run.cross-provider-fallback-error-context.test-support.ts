// Full-entry coverage for current-attempt error context across model fallback.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
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
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
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
  return createModelFallbackConfig("openai/gpt-5.4", [
    "deepseek/deepseek-chat",
    "google/gemini-2.5-flash",
  ]);
}

function useCrossProviderAuthFixture() {
  const store = {
    version: 1 as const,
    profiles: {
      "anthropic:test": {
        type: "api_key" as const,
        provider: "anthropic",
        key: "fixture",
      },
      "deepseek:test": {
        type: "api_key" as const,
        provider: "deepseek",
        key: "fixture",
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
  const assistant = makeAssistantMessageFixture({
    stopReason: "error",
    errorMessage: COMPACTION_REMOVED_ERROR_MESSAGE,
    provider: "anthropic",
    model: "test-model",
    content: [],
  });
  // The pinned profile may rotate to another same-provider credential before
  // the outer model fallback runs, so every credential attempt must fail alike.
  mockedRunEmbeddedAttempt.mockResolvedValue(
    makeAttemptResult({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: assistant,
    }),
  );
}

function runCompactionRemovedFallbackAttempt(ownedState: OpenClawTestState) {
  return runEmbeddedAgent({
    ...createOverflowRunParams(ownedState),
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

async function expectDeepseekFallbackError(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
  // The user-facing copy is composed by the real (unmocked) renderer; the
  // current-attempt provider/model appearing in it is the attribution proof.
  await expect(promise).rejects.toThrow("deepseek (deepseek-chat) returned a billing error");
  expect(mockedIsRateLimitAssistantError).toHaveBeenCalledTimes(1);
  const rateLimitCalls = mockedIsRateLimitAssistantError.mock.calls as unknown[][];
  expectDeepseekAssistant(rateLimitCalls.at(-1)?.[0]);
}

describe("runEmbeddedAgent cross-provider fallback error handling", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    await withOpenClawTestState({ label: "cross-provider-warmup" }, async (warmupState) => {
      await warmRunOverflowCompactionHarness(runEmbeddedAgent, warmupState, {
        config: makeCrossProviderFallbackConfig(),
        agentHarnessRuntimeOverride: "openclaw",
        provider: "deepseek",
        model: "deepseek-chat",
      });
      setupCompactionRemovedFallbackAttempt();
      await runCompactionRemovedFallbackAttempt(warmupState).catch(() => undefined);
    });
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.cross-provider-fallback-error-context" });
    useCrossProviderAuthFixture();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("uses the current attempt assistant for fallback errors instead of stale session history", async () => {
    setupDeepseekFallbackErrorMatchers();
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
      ...createOverflowRunParams(state),
      runId: "run-cross-provider-fallback-error-context",
      config: makeCrossProviderFallbackConfig(),
      agentHarnessRuntimeOverride: "openclaw",
      provider: "deepseek",
      model: "deepseek-chat",
      authProfileId: "deepseek:test",
      authProfileIdSource: "user",
      modelFallbacksOverride: ["deepseek/deepseek-chat"],
    });

    await expectDeepseekFallbackError(promise);
  });

  it("uses the completed assistant when compaction removes the current attempt slice", async () => {
    const getLastFormattedAssistant = captureFormattedAssistant();
    setupCompactionRemovedFallbackAttempt();
    const promise = runCompactionRemovedFallbackAttempt(state);

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("⚠️ Agent run failed (model: anthropic/test-model).");
    expect(mockedIsFailoverAssistantError).toHaveBeenCalledTimes(2);
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
      ...createOverflowRunParams(state),
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
      ...createOverflowRunParams(state),
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

  it("does not present stale successful-assistant errors as the current timeout", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        currentAttemptAssistant: makeAssistantMessageFixture({
          stopReason: "stop",
          errorMessage: "500 stale provider diagnostic",
          provider: "deepseek",
          model: "deepseek-chat",
          content: [],
        }),
      }),
    );

    const promise = runEmbeddedAgent({
      ...createOverflowRunParams(state),
      runId: "run-successful-assistant-stale-error-timeout",
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
    await expect(promise).rejects.not.toThrow("500");
    await expect(promise).rejects.not.toThrow("stale provider diagnostic");
  });

  it("does not retry successful replies for stale unsupported-thinking errors", async () => {
    const helpers = await import("../embedded-agent-helpers.js");
    const thinking = await import("../embedded-agent-helpers/thinking.js");
    const thinkingMock = vi.mocked(helpers.pickFallbackThinkingLevel);
    const previousThinking = thinkingMock.getMockImplementation();
    thinkingMock.mockImplementation(thinking.pickFallbackThinkingLevel);
    try {
      mockedRunEmbeddedAttempt.mockResolvedValue(
        makeAttemptResult({
          assistantTexts: ["Successful reply"],
          currentAttemptAssistant: makeAssistantMessageFixture({
            stopReason: "stop",
            errorMessage: 'think value "high" is not supported for this model',
            provider: "deepseek",
            model: "deepseek-chat",
            content: [{ type: "text", text: "Successful reply" }],
          }),
        }),
      );

      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        runId: "run-successful-assistant-stale-thinking",
        config: makeCrossProviderFallbackConfig(),
        agentHarnessRuntimeOverride: "openclaw",
        provider: "deepseek",
        model: "deepseek-chat",
        thinkLevel: "high",
        authProfileId: "deepseek:test",
        authProfileIdSource: "user",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(result.meta.finalAssistantVisibleText).toBe("Successful reply");
    } finally {
      thinkingMock.mockReset();
      if (previousThinking) {
        thinkingMock.mockImplementation(previousThinking);
      }
    }
  });
});
