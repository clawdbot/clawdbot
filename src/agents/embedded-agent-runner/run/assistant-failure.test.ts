import http from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../../../../packages/ai/src/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
} from "../../../llm/types.js";
import { classifyAssistantFailoverReason } from "../../embedded-agent-helpers/assistant-message-failures.js";
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

vi.mock("../../../plugins/provider-failover.js", () => providerRuntimeMocks);

const CREDENTIAL_FILE_ENOENT_MESSAGE =
  "ENOENT: no such file or directory, open '/home/operator/.claude/.credentials.json'";
const INCOMPLETE_TERMINAL_STREAM_MESSAGE = "Bedrock stream ended before messageStop";
const INCOMPLETE_TERMINAL_STREAM_CASES = [
  { provider: "amazon-bedrock", message: INCOMPLETE_TERMINAL_STREAM_MESSAGE },
  { provider: "mistral", message: "Mistral stream ended without a terminal finish reason" },
] as const;

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
    previousRetryFailoverReason: null,
    maybeMarkAuthProfileFailure,
    getTransientRetryCount: () => 0,
    maybeRetryTransient: vi.fn(async () => false),
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
  fixture.input.maybeRetryTransient = vi.fn(async () => true);
  fixture.input.advanceRateLimitAuthProfile = vi.fn(async () => true);
  return fixture;
}

function makeTerminalStreamFailureInput(options?: {
  assistant?: AssistantMessage;
  errorMessage?: string;
  fallbackConfigured?: boolean;
  model?: string;
  profileAvailable?: boolean;
  provider?: string;
}) {
  const fixture = makeExhaustedCredentialFailureInput();
  const provider = options?.provider ?? options?.assistant?.provider ?? "amazon-bedrock";
  const model = options?.model ?? options?.assistant?.model ?? "mock-1";
  const assistant =
    options?.assistant ??
    buildEmbeddedRunnerAssistant({
      provider,
      model,
      stopReason: "error",
      errorMessage: options?.errorMessage ?? INCOMPLETE_TERMINAL_STREAM_MESSAGE,
      content: [{ type: "text", text: "I have" }],
    });
  const assistantText = assistant.content.find((part) => part.type === "text")?.text;
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: assistantText ? [assistantText] : [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
  fixture.input.attempt = attempt;
  fixture.input.attemptAssistant = assistant;
  fixture.input.currentAttemptAssistant = assistant;
  fixture.input.terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
  fixture.input.activeErrorContext = { provider, model };
  fixture.input.provider = provider;
  fixture.input.providerOwner = undefined;
  fixture.input.modelId = model;
  fixture.input.model = model;
  fixture.input.fallbackConfigured = options?.fallbackConfigured !== false;
  fixture.input.authProfileId = undefined;
  fixture.input.emptyErrorRetries = 0;
  fixture.input.advanceAuthProfile = vi.fn(async () => options?.profileAvailable !== false);
  return fixture;
}

async function streamIncompleteMistralResponseOverLoopback() {
  const { streamMistral } = await import("../../../../packages/ai/src/providers/mistral.js");
  const partialText = "Safe partial answer";
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "terminal-stream-recovery-proof",
        object: "chat.completion.chunk",
        created: 1,
        model: "mistral-large-latest",
        choices: [
          {
            index: 0,
            delta: { content: partialText },
            finish_reason: null,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })}\n\n`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const model = {
    id: "mistral-large-latest",
    name: "Mistral terminal recovery proof",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: `http://127.0.0.1:${port}`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } satisfies Model<"mistral-conversations">;
  const context = {
    messages: [{ role: "user", content: "Inspect only", timestamp: 1 }],
  } satisfies Context;

  try {
    const stream = streamMistral(model, context, { apiKey: "redacted-fixture-token" });
    for await (const event of stream) {
      // Drain the installed SDK's real event stream before reading its result.
      void event;
    }
    return { assistant: await stream.result(), partialText };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("handleEmbeddedAssistantFailure", () => {
  beforeEach(() => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReset();
  });

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
    fixture.input.providerOwner = {
      id: "openrouter",
      classifyFailoverReason: ({ errorMessage: classifiedError }) =>
        classifiedError === errorMessage ? "billing" : undefined,
    };
    fixture.input.resolveAuthProfileFailureReason = vi.fn((reason) =>
      reason === "billing" ? "billing" : null,
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

  it("uses the prepared OpenAI owner for structured Responses failures", async () => {
    const fixture = makeExhaustedCredentialFailureInput();
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "openai",
      model: "gpt-5.6-luna",
      stopReason: "error",
      errorMessage: "server_error: provider failed",
      errorCode: "server_error",
    });
    const attempt = makeEmbeddedRunnerAttempt({
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });
    fixture.input.attempt = attempt;
    fixture.input.attemptAssistant = assistant;
    fixture.input.currentAttemptAssistant = assistant;
    fixture.input.terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    fixture.input.provider = "openai";
    fixture.input.providerOwner = {
      id: "openai",
      classifyFailoverReason: ({ code }) =>
        code?.toUpperCase() === "SERVER_ERROR" ? "server_error" : undefined,
    };
    fixture.input.modelId = "gpt-5.6-luna";
    fixture.input.model = "gpt-5.6-luna";
    fixture.input.activeErrorContext = { provider: "openai", model: "gpt-5.6-luna" };
    fixture.input.authProfileId = undefined;
    fixture.input.advanceAuthProfile = vi.fn(async () => false);
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValue(undefined);

    await expect(handleEmbeddedAssistantFailure(fixture.input)).rejects.toMatchObject({
      reason: "server_error",
      status: 500,
    });
  });

  it.each([PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE, PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE])(
    "does not rotate profiles or models after replay-unsafe failure %s",
    async (errorCode) => {
      const fixture = makeExhaustedCredentialFailureInput();
      fixture.input.emptyErrorRetries = 0;
      if (!fixture.input.attemptAssistant) {
        throw new Error("expected assistant fixture");
      }
      fixture.input.attemptAssistant.errorCode = errorCode;
      fixture.input.attemptAssistant.errorMessage = "reasoning is required";
      fixture.input.resolveAuthProfileFailureReason = vi.fn(() => "timeout" as const);

      const outcome = await handleEmbeddedAssistantFailure(fixture.input);

      expect(outcome).toMatchObject({ action: "proceed", assistantProfileFailureReason: null });
      expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
      expect(fixture.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
      expect(fixture.traceAttempts).toEqual([]);
    },
  );

  it.each(INCOMPLETE_TERMINAL_STREAM_CASES)(
    "rotates profiles for a $provider terminal stream with visible partial output",
    async ({ provider, message }) => {
      const fixture = makeTerminalStreamFailureInput({ errorMessage: message, provider });

      const outcome = await handleEmbeddedAssistantFailure(fixture.input);

      expect(outcome).toMatchObject({
        action: "retry",
        lastRetryFailoverReason: "timeout",
      });
      expect(fixture.input.advanceAuthProfile).toHaveBeenCalledOnce();
      expect(fixture.traceAttempts).toEqual([
        {
          provider,
          model: "mock-1",
          result: "timeout",
          reason: "timeout",
          stage: "assistant",
        },
      ]);
    },
  );

  it("recovers a real loopback Mistral partial EOF through embedded model fallback", async () => {
    const { assistant, partialText } = await streamIncompleteMistralResponseOverLoopback();
    const classification = classifyAssistantFailoverReason(assistant);
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "mistral/mistral-large-latest",
            fallbacks: ["google/mock-2"],
          },
        },
      },
    } satisfies OpenClawConfig;
    const calls: string[] = [];
    let embeddedFailure: { reason: string; rawError?: string } | undefined;
    let embeddedTrace: AssistantFailureInput["traceAttempts"] = [];

    const result = await runWithModelFallback({
      cfg: config,
      provider: "mistral",
      model: "mistral-large-latest",
      sessionId: "session:mistral-terminal-recovery-proof",
      skipAuthProfileRuntime: true,
      run: async (provider, model) => {
        calls.push(`${provider}/${model}`);
        if (provider === "mistral") {
          const fixture = makeTerminalStreamFailureInput({
            assistant,
            model,
            profileAvailable: false,
            provider,
          });
          embeddedTrace = fixture.traceAttempts;
          try {
            await handleEmbeddedAssistantFailure(fixture.input);
          } catch (error) {
            if (error instanceof FailoverError) {
              embeddedFailure = { reason: error.reason, rawError: error.rawError };
            }
            throw error;
          }
        }
        return "fallback complete";
      },
    });

    const proof = {
      transport: "http://127.0.0.1:<redacted>/chat/completions (SSE EOF)",
      partialText,
      producerError: assistant.errorMessage,
      classification,
      embeddedFailure,
      embeddedTrace,
      calls,
      finalResult: result.result,
      partialReturned: result.result.includes(partialText),
    };
    expect(assistant).toMatchObject({
      stopReason: "error",
      errorMessage: "Mistral stream ended without a terminal finish reason",
    });
    expect(assistant.content).toContainEqual({ type: "text", text: partialText });
    expect(classification).toBe("timeout");
    expect(embeddedFailure).toEqual({
      reason: "timeout",
      rawError: "Mistral stream ended without a terminal finish reason",
    });
    expect(embeddedTrace).toEqual([
      {
        provider: "mistral",
        model: "mistral-large-latest",
        result: "timeout",
        reason: "timeout",
        stage: "assistant",
        status: 408,
      },
    ]);
    expect(calls).toEqual(["mistral/mistral-large-latest", "google/mock-2"]);
    expect(result.result).toBe("fallback complete");
    expect(proof.partialReturned).toBe(false);
    console.log(`[terminal-stream recovery proof] ${JSON.stringify(proof)}`);
  });

  it.each(INCOMPLETE_TERMINAL_STREAM_CASES)(
    "advances model fallback instead of returning a partial $provider terminal-stream error",
    async ({ provider, message }) => {
      const config = {
        agents: {
          defaults: {
            model: {
              primary: `${provider}/mock-1`,
              fallbacks: ["google/mock-2"],
            },
          },
        },
      } satisfies OpenClawConfig;
      const calls: string[] = [];

      const result = await runWithModelFallback({
        cfg: config,
        provider,
        model: "mock-1",
        sessionId: `session:incomplete-terminal-stream:${provider}`,
        skipAuthProfileRuntime: true,
        run: async (candidateProvider, model) => {
          calls.push(`${candidateProvider}/${model}`);
          if (candidateProvider === provider) {
            await handleEmbeddedAssistantFailure(
              makeTerminalStreamFailureInput({
                errorMessage: message,
                profileAvailable: false,
                provider,
              }).input,
            );
          }
          return "fallback complete";
        },
      });

      expect(result.result).toBe("fallback complete");
      expect(calls).toEqual([`${provider}/mock-1`, "google/mock-2"]);
    },
  );

  it("surfaces an incomplete terminal-stream error when no retry target remains", async () => {
    const fixture = makeTerminalStreamFailureInput({
      fallbackConfigured: false,
      profileAvailable: false,
    });

    await expect(handleEmbeddedAssistantFailure(fixture.input)).rejects.toMatchObject({
      reason: "timeout",
      provider: "amazon-bedrock",
      model: "mock-1",
      rawError: INCOMPLETE_TERMINAL_STREAM_MESSAGE,
    });
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
    expect(fixture.input.maybeRetryTransient).not.toHaveBeenCalled();
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.input.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([]);
  });

  it("keeps replay-safe idle timeout profile rotation available", async () => {
    const fixture = makeIdleTimeoutFailureInput({ replaySafe: true });
    fixture.input.maybeRefreshRuntimeAuthForAuthError = vi.fn(async () => false);
    // Retry budget exhausted: the silent idle timeout consults the transient
    // owner first, then falls through to profile rotation.
    fixture.input.maybeRetryTransient = vi.fn(async () => false);

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(fixture.input.maybeRetryTransient).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "timeout" }),
    );
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

  it.each(["HTTP 429 Too Many Requests", INCOMPLETE_TERMINAL_STREAM_MESSAGE])(
    "does not route a caller timeout with %s through failover",
    async (errorMessage) => {
      const fixture = makeExhaustedCredentialFailureInput();
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: "error",
        errorMessage,
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
      fixture.input.maybeRetryTransient = vi.fn(async () => true);

      const outcome = await handleEmbeddedAssistantFailure(fixture.input);

      expect(outcome.action).toBe("proceed");
      expect(fixture.input.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
      expect(fixture.input.maybeRetryTransient).not.toHaveBeenCalled();
      expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
      expect(fixture.input.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
      expect(fixture.traceAttempts).toEqual([]);
    },
  );

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
    fixture.input.maybeRetryTransient = vi.fn(async () => true);
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReturnValueOnce("rate_limit");

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({
      action: "retry",
    });
    expect(fixture.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([
      {
        provider: "anthropic",
        model: "mock-1",
        result: "same_model_transient",
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
    fixture.input.maybeRetryTransient = vi.fn(async () => true);

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome).toMatchObject({
      action: "retry",
      emptyErrorRetries: 1,
    });
    expect(fixture.input.maybeRefreshRuntimeAuthForAuthError).not.toHaveBeenCalled();
    expect(fixture.input.maybeRetryTransient).not.toHaveBeenCalled();
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
