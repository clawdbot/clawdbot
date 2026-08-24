import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE } from "../../../llm/types.js";
import { FailoverError } from "../../failover-error.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(),
}));

vi.mock("../../../logging/node-require.js", () => ({
  resolveNodeRequireFromMeta: () => () => providerRuntimeMocks,
}));

const CREDENTIAL_FILE_ENOENT_MESSAGE =
  "ENOENT: no such file or directory, open '/home/operator/.claude/.credentials.json'";

type AssistantFailureInput = Parameters<typeof handleEmbeddedAssistantFailure>[0];

function makeExhaustedCredentialFailureInput(options?: { replaySafe?: boolean }) {
  const replaySafe = options?.replaySafe !== false;
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "anthropic",
    model: "mock-1",
    stopReason: "error",
    errorMessage: CREDENTIAL_FILE_ENOENT_MESSAGE,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    toolMetas: replaySafe ? [] : [{ toolName: "write", replaySafe: false }],
  });
  const advanceAuthProfile = vi.fn(async () => true);
  const maybeMarkAuthProfileFailure = vi.fn(async () => {});
  const traceAttempts: AssistantFailureInput["traceAttempts"] = [];
  const input: AssistantFailureInput = {
    runParams: {
      sessionId: "session:credential-enoent",
      runId: "run:credential-enoent",
      config: undefined,
    } as AssistantFailureInput["runParams"],
    attempt,
    attemptAssistant: assistant,
    currentAttemptAssistant: assistant,
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant,
    }),
    activeErrorContext: { provider: "anthropic", model: "mock-1" },
    provider: "anthropic",
    providerOwner: undefined,
    modelId: "mock-1",
    model: "mock-1",
    thinkLevel: "off",
    getThinkLevel: () => "off",
    attemptedThinking: new Set(["off"]),
    fallbackConfigured: true,
    pluginHarnessOwnsTransport: false,
    canRestartForLiveSwitch: false,
    authProfileId: "anthropic:p1",
    authProfileStore: {
      version: 1,
      profiles: {
        "anthropic:p1": {
          type: "api_key",
          provider: "anthropic",
          key: "test-key",
        },
        "anthropic:p2": {
          type: "api_key",
          provider: "anthropic",
          key: "test-key-2",
        },
      },
      usageStats: {
        "anthropic:p1": { lastUsed: 1 },
        "anthropic:p2": { lastUsed: 2 },
      },
    },
    runtimeAuthRetry: false,
    maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    resolveAuthProfileFailureReason: () => null,
    emptyErrorRetries: 3,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 1,
    sameModelIdleTimeoutRetries: 0,
    previousRetryFailoverReason: null,
    maybeMarkAuthProfileFailure,
    maybeRetrySameModelRateLimit: vi.fn(async () => false),
    maybeBackoffBeforeOverloadFailover: vi.fn(async () => {}),
    advanceAuthProfile,
    advanceRateLimitAuthProfile: vi.fn(async () => true),
    traceAttempts,
    suspendForFailure: vi.fn(),
    suspensionSessionId: "session:credential-enoent",
    agentDir: "/tmp/openclaw-assistant-failure-test",
    isProbeSession: false,
  };
  return {
    advanceAuthProfile,
    input,
    maybeMarkAuthProfileFailure,
    traceAttempts,
  };
}

function makeIdleTimeoutFailureInput(options?: { replaySafe?: boolean }) {
  const fixture = makeExhaustedCredentialFailureInput();
  const replaySafe = options?.replaySafe === true;
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "anthropic",
    model: "mock-1",
    stopReason: "aborted",
  });
  const replayMetadata = {
    hadPotentialSideEffects: !replaySafe,
    replaySafe,
  };
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: { kind: "timeout", phase: "prompt", source: "idle" },
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    toolMetas: replaySafe ? [] : [{ toolName: "write", replaySafe: false }],
    replayMetadata,
    currentAttemptReplayMetadata: replayMetadata,
  });
  fixture.input.attempt = attempt;
  fixture.input.attemptAssistant = assistant;
  fixture.input.currentAttemptAssistant = assistant;
  fixture.input.terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
  fixture.input.emptyErrorRetries = 0;
  fixture.input.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => true);
  fixture.input.maybeRetrySameModelRateLimit = vi.fn(async () => true);
  fixture.input.advanceRateLimitAuthProfile = vi.fn(async () => true);
  return fixture;
}

describe("handleEmbeddedAssistantFailure", () => {
  it.each(["auth", "auth_permanent"] as const)(
    "carries %s profile failures into terminal resolution",
    async (reason) => {
      const fixture = makeExhaustedCredentialFailureInput();
      if (!fixture.input.attemptAssistant) {
        throw new Error("expected assistant fixture");
      }
      fixture.input.attemptAssistant.provider = "openai";
      fixture.input.attemptAssistant.model = "gpt-5.6-luna";
      fixture.input.attemptAssistant.errorMessage = undefined;
      Object.assign(fixture.input, {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        model: "gpt-5.6-luna",
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        fallbackConfigured: false,
        authProfileId: undefined,
        resolveAuthProfileFailureReason: vi.fn(() => reason),
      });
      const outcome = await handleEmbeddedAssistantFailure(fixture.input);

      expect(outcome).toMatchObject({
        action: "proceed",
        assistantProfileFailureReason: reason,
      });
    },
  );

  it("uses prepared OpenRouter ownership for custom-provider billing failures", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const provider = "custom-openrouter";
    const modelId = "anthropic/claude-sonnet-4";
    const errorMessage = "HTTP 403: API key budget limit exceeded";
    const assistant = buildEmbeddedRunnerAssistant({
      provider,
      model: modelId,
      stopReason: "error",
      errorMessage,
    });
    fixture.input.attemptAssistant = assistant;
    fixture.input.currentAttemptAssistant = assistant;
    fixture.input.provider = provider;
    fixture.input.modelId = modelId;
    fixture.input.model = modelId;
    fixture.input.activeErrorContext = { provider, model: modelId };
    fixture.input.authProfileId = undefined;
    fixture.input.providerOwner = { id: "openrouter" };
    fixture.input.resolveAuthProfileFailureReason = vi.fn((reason) =>
      reason === "billing" ? "billing" : null,
    );
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockImplementation(
      ({ provider: classifiedProvider, context }) =>
        classifiedProvider === "openrouter" && context.errorMessage === errorMessage
          ? "billing"
          : undefined,
    );

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({
      action: "retry",
      lastRetryFailoverReason: "billing",
    });
    expect(fixture.traceAttempts).toEqual([
      {
        provider,
        model: modelId,
        result: "rotate_profile",
        reason: "billing",
        stage: "assistant",
      },
    ]);
  });

  it("does not rotate profiles or models after an ambiguous post-dispatch failure", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    fixture.input.emptyErrorRetries = 0;
    if (!fixture.input.attemptAssistant) {
      throw new Error("expected assistant fixture");
    }
    fixture.input.attemptAssistant.errorCode = PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE;
    fixture.input.attemptAssistant.errorMessage = "reasoning is required";
    fixture.input.resolveAuthProfileFailureReason = vi.fn(() => "timeout" as const);

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({ action: "proceed", assistantProfileFailureReason: null });
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([]);
  });

  it("falls back after exhausted replay-safe credential-file retries without touching auth state", async () => {
    const fixture = makeExhaustedCredentialFailureInput();

    await expect(handleEmbeddedAssistantFailure(fixture.input)).rejects.toMatchObject({
      reason: "unknown",
      provider: "anthropic",
      model: "mock-1",
      rawError: CREDENTIAL_FILE_ENOENT_MESSAGE,
    });

    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(fixture.input.authProfileStore.usageStats).toEqual({
      "anthropic:p1": { lastUsed: 1 },
      "anthropic:p2": { lastUsed: 2 },
    });
    expect(fixture.traceAttempts).toEqual([
      {
        provider: "anthropic",
        model: "mock-1",
        result: "fallback_model",
        reason: "unknown",
        stage: "assistant",
      },
    ]);
  });

  it("does not fallback credential-file ENOENT after replay-unsafe tool activity", async () => {
    const fixture = makeExhaustedCredentialFailureInput({ replaySafe: false });

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome.action).toBe("proceed");
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([]);
  });

  it("closes every failover retry after an idle timeout commits a write", async () => {
    const fixture = makeIdleTimeoutFailureInput();

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome.action).toBe("proceed");
    expect(fixture.input.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
    expect(fixture.input.maybeRetrySameModelRateLimit).not.toHaveBeenCalled();
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.input.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([]);
  });

  it("keeps replay-safe idle timeout profile rotation available", async () => {
    const fixture = makeIdleTimeoutFailureInput({ replaySafe: true });
    fixture.input.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => false);

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({ action: "retry", lastRetryFailoverReason: "timeout" });
    expect(fixture.advanceAuthProfile).toHaveBeenCalledOnce();
    expect(fixture.traceAttempts).toEqual([
      {
        provider: "anthropic",
        model: "mock-1",
        result: "rotate_profile",
        stage: "assistant",
      },
    ]);
  });

  it("does not route a caller timeout with stale rate-limit metadata through failover", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "error",
      errorMessage: "HTTP 429 Too Many Requests",
    });
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: { kind: "timeout", phase: "prompt", source: "external" },
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    fixture.input.attempt = attempt;
    fixture.input.attemptAssistant = assistant;
    fixture.input.currentAttemptAssistant = assistant;
    fixture.input.terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    fixture.input.emptyErrorRetries = 0;
    fixture.input.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => true);
    fixture.input.maybeRetrySameModelRateLimit = vi.fn(async () => true);

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome.action).toBe("proceed");
    expect(fixture.input.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
    expect(fixture.input.maybeRetrySameModelRateLimit).not.toHaveBeenCalled();
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.input.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([]);
  });

  it("records a same-model rate-limit retry without a profile-rotation trace", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "error",
      errorMessage: "HTTP 429 Too Many Requests",
      content: [{ type: "text", text: "rate limited" }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    fixture.input.attempt = attempt;
    fixture.input.attemptAssistant = assistant;
    fixture.input.currentAttemptAssistant = assistant;
    fixture.input.terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    fixture.input.emptyErrorRetries = 0;
    fixture.input.maybeRetrySameModelRateLimit = vi.fn(async () => true);
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValueOnce("rate_limit");

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({
      action: "retry",
      preserveSameModelRateLimitRetryCount: true,
    });
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([
      {
        provider: "anthropic",
        model: "mock-1",
        result: "same_model_rate_limit",
        reason: "rate_limit",
        stage: "assistant",
      },
    ]);
  });

  it("retries a replay-safe reasoning-only assistant error before failover", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "openai",
      model: "gpt-5.6-luna",
      stopReason: "error",
      errorMessage: "provider failed after emitting reasoning",
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs_error_turn", type: "reasoning" }),
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    fixture.input.attempt = attempt;
    fixture.input.attemptAssistant = assistant;
    fixture.input.currentAttemptAssistant = assistant;
    fixture.input.terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    fixture.input.emptyErrorRetries = 0;
    fixture.input.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => true);
    fixture.input.maybeRetrySameModelRateLimit = vi.fn(async () => true);

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({
      action: "retry",
      emptyErrorRetries: 1,
      preserveSameModelRateLimitRetryCount: true,
    });
    expect(fixture.input.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
    expect(fixture.input.maybeRetrySameModelRateLimit).not.toHaveBeenCalled();
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([]);
  });

  it("does not cache an exact credential-file failure from a fallback candidate", async () => {
    const previous = process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
    process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = "60000";
    try {
      const config = {
        agents: {
          defaults: {
            model: {
              primary: "openai/mock-0",
              fallbacks: ["anthropic/mock-1", "groq/mock-2"],
            },
          },
        },
      } satisfies OpenClawConfig;
      const calls: string[] = [];
      const run = async (provider: string, model: string) => {
        calls.push(`${provider}/${model}`);
        if (provider === "openai") {
          throw new FailoverError("primary rate limited", {
            provider,
            model,
            reason: "rate_limit",
          });
        }
        if (provider === "anthropic") {
          await handleEmbeddedAssistantFailure(makeExhaustedCredentialFailureInput().input);
        }
        return "ok";
      };

      for (let turn = 0; turn < 2; turn += 1) {
        const result = await runWithModelFallback({
          cfg: config,
          provider: "openai",
          model: "mock-0",
          sessionId: "session:credential-enoent-no-skip",
          skipAuthProfileRuntime: true,
          run,
        });
        expect(result.result).toBe("ok");
      }

      expect(calls).toEqual([
        "openai/mock-0",
        "anthropic/mock-1",
        "groq/mock-2",
        "openai/mock-0",
        "anthropic/mock-1",
        "groq/mock-2",
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
      } else {
        process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = previous;
      }
    }
  });
});
