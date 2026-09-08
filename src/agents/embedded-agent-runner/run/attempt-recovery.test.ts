import { APIError } from "openai/core/error";
import { describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { normalizeUsage } from "../../usage.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { recoverEmbeddedRunAttempt } from "./attempt-recovery.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

type TransportDropScenario = {
  errorMessage?: string;
  errorBody?: string;
  errorCode?: string;
  errorType?: string;
  completedAssistant?: AssistantMessage;
  compactionEnabled?: boolean;
  content?: AssistantMessage["content"];
  diagnostics?: AssistantMessage["diagnostics"];
  activeCount?: number;
  codeModeSuspended?: boolean;
  failedToolCallId?: string;
  lastToolError?: Parameters<typeof makeEmbeddedRunnerAttempt>[0]["lastToolError"];
  retryAvailable?: boolean;
  replaySafe?: boolean;
  terminal?: Parameters<typeof makeEmbeddedRunnerAttempt>[0]["terminal"];
  yieldDetected?: boolean;
};

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

const disabledCompactionRuntime = {
  prepareRecoveryOwner: () => {
    throw new Error("Compaction is disabled in this recovery fixture");
  },
};

// Live shape: a code-mode exec batch settled, then the ChatGPT Responses stream
// died while the model was still reasoning, so the errored turn is thinking-only.
async function recoverAfterTransportDrop(scenario: TransportDropScenario = {}) {
  const toolCalls = ["call_1", "call_2"];
  const toolAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: toolCalls.map((id) => ({ type: "toolCall", id, name: "exec", arguments: {} })),
  });
  const erroredAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "error",
    errorMessage: scenario.errorMessage ?? "WebSocket error",
    errorBody: scenario.errorBody,
    errorCode: scenario.errorCode,
    errorType: scenario.errorType,
    diagnostics:
      scenario.diagnostics ??
      ([
        {
          type: "provider_transport_failure",
          error: { message: "WebSocket error" },
          details: { phase: "after_message_stream_start" },
        },
      ] as never),
    content: scenario.content ?? [{ type: "thinking", thinking: "checking the results" }],
    usage: createMockUsage(0, 0),
  });
  const messagesSnapshot = [
    { role: "user", content: "why is it unauthorized?" },
    toolAssistant,
    ...toolCalls.map((id) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "exec",
      isError: id === scenario.failedToolCallId,
    })),
    erroredAssistant,
  ] as never;
  const attempt = makeEmbeddedRunnerAttempt({
    messagesSnapshot,
    toolMetas: toolCalls.map((toolCallId) => ({
      toolCallId,
      toolName: "exec",
      replaySafe: false,
      ...(scenario.codeModeSuspended ? { codeModeSuspended: true } : {}),
    })) as never,
    lastAssistant: erroredAssistant,
    currentAttemptAssistant: erroredAssistant,
    ...(scenario.completedAssistant
      ? { currentAttemptCompletedAssistant: scenario.completedAssistant }
      : {}),
    lastToolError: scenario.lastToolError,
    itemLifecycle: {
      startedCount: toolCalls.length,
      completedCount: toolCalls.length,
      activeCount: scenario.activeCount ?? 0,
    },
    ...(scenario.terminal ? { terminal: scenario.terminal } : {}),
    ...(scenario.yieldDetected ? { yieldDetected: true } : {}),
    ...(scenario.replaySafe
      ? { currentAttemptReplayMetadata: { replaySafe: true, hadPotentialSideEffects: false } }
      : {}),
  });
  const terminalState = resolveEmbeddedRunAttemptTerminalState({
    attempt,
    assistant: erroredAssistant,
  });
  const markOwnedTranscriptRetry = vi.fn();
  const continueFromCurrentTranscript = vi.fn();
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  const failoverRetryController = createEmbeddedRunFailoverRetryController({
    runParams: { runId: "run:transport-drop" } as Parameters<
      typeof createEmbeddedRunFailoverRetryController
    >[0]["runParams"],
    provider: "openai",
    modelId: "gpt-5.6-luna",
    globalLane: "test",
    agentDir: "/tmp/provider-recovery-test",
    fallbackConfigured: false,
    profileFailureStore: { version: 1, profiles: {} },
    getLastProfileId: () => undefined,
    getSessionId: () => "session:transport-drop",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile: vi.fn(async () => false),
  });
  if (scenario.retryAvailable === false) {
    failoverRetryController.setTransientRetryBudget(0);
  }
  vi.spyOn(failoverRetryController, "maybeMarkAuthProfileFailure");
  const onAgentEvent = vi.fn();
  const recover = () =>
    recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          config: {},
          agentId: "main",
          sessionId: "session:transport-drop",
          runId: "run:transport-drop",
          onAgentEvent,
        },
        resolvedSessionKey: "agent:main:transport-drop",
        startedAtMs: Date.now(),
        laneController: { throwIfAborted: vi.fn() },
      },
      preparedRuntime: {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        model: { id: "gpt-5.6-luna" },
        genericCompactionRecoveryAllowed: scenario.compactionEnabled ?? false,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "openclaw" },
          outerContextTokenMeta: {},
          contextTokenBudget: scenario.compactionEnabled ? 200_000 : undefined,
          pluginHarnessOwnsTransport: false,
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: erroredAssistant,
        currentAttemptAssistant: erroredAssistant,
        currentAttemptCompletedAssistant: scenario.completedAssistant,
        assistantErrorText: erroredAssistant.errorMessage,
        terminalState,
        setTerminalLifecycleMeta: vi.fn(),
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        resolveReplayInvalidForAttempt: () => true,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: {
        sessionFile: "/tmp/session.jsonl",
        markOwnedTranscriptRetry,
        continueFromCurrentTranscript,
      },
      failoverRetryController,
      compactionRuntime: {
        ...disabledCompactionRuntime,
        assertRecoveryActive: () => {
          throw new Error("overflow compaction requested");
        },
      },
      contextRecoveryState,
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: undefined,
      runtimeAuthRetry: false,
      codexAppServerRecoveryRetryAvailable: false,
      codexAppServerRecoveryRetries: 0,
      lastRetryFailoverReason: null,
      traceAttempts: [],
      sessionAgentId: "main",
    } as never);
  const recovery = await recover();
  return {
    recovery,
    recover,
    attempt,
    erroredAssistant,
    markOwnedTranscriptRetry,
    continueFromCurrentTranscript,
    contextRecoveryState,
    failoverRetryController,
    onAgentEvent,
  };
}

describe("recoverEmbeddedRunAttempt", () => {
  it.each(["validation", "success"])(
    "does not recover stale overflow after a completed %s response",
    async (completed) => {
      const completedAssistant = buildEmbeddedRunnerAssistant(
        completed === "validation"
          ? {
              stopReason: "error",
              errorMessage: "500 Unsupported parameter: context_length_exceeded",
              errorType: "invalid_request_error",
              errorCode: "unknown_parameter",
            }
          : { stopReason: "stop", content: [{ type: "text", text: "Done" }] },
      );
      const { recovery, markOwnedTranscriptRetry } = await recoverAfterTransportDrop({
        errorMessage: "400 context overflow",
        completedAssistant,
        compactionEnabled: true,
        diagnostics: [],
        replaySafe: true,
      });
      expect(recovery).toEqual({ action: "proceed" });
      expect(markOwnedTranscriptRetry).not.toHaveBeenCalled();
    },
  );

  it("recovers the completed overflow instead of using another assistant's validation", async () => {
    await expect(
      recoverAfterTransportDrop({
        errorMessage: "500 Unsupported parameter: timeout",
        errorType: "invalid_request_error",
        errorCode: "unknown_parameter",
        completedAssistant: buildEmbeddedRunnerAssistant({
          stopReason: "error",
          errorMessage: "400 Your input exceeds the context window of this model",
        }),
        compactionEnabled: true,
        diagnostics: [],
        replaySafe: true,
      }),
    ).rejects.toThrow("overflow compaction requested");
  });

  it.each([
    { errorMessage: "429 rate_limit_exceeded; Retry-After: 3600", delayMs: 3_600_000 },
    { errorMessage: "429 rate_limit_exceeded; Retry-After: 30 seconds", delayMs: 30_000 },
    { errorMessage: "429 tokens per minute exceeded. Please try again in 5000ms.", delayMs: 5000 },
    {
      errorMessage: "429 requests per minute exceeded. Please try again in 11.054s.",
      delayMs: 11_054,
    },
    { headers: { "retry-after": "7", "retry-after-ms": "8500" }, delayMs: 8500 },
    { headers: { "Retry-After": "7", "retry-after-ms": "335" }, delayMs: 7000 },
    { headers: { "retry-after": "7", "retry-after-ms": "invalid" }, delayMs: 7000 },
  ])("continues after respecting the provider floor of $delayMs ms", async (scenario) => {
    vi.mocked(sleepWithAbort).mockClear();
    const { recovery, onAgentEvent, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop({
        errorMessage: scenario.errorMessage ?? "429 provider rate limit",
        errorBody: scenario.headers ? JSON.stringify({ headers: scenario.headers }) : undefined,
        diagnostics: [],
      });
    expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: "rate_limit" });
    expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(scenario.delayMs, undefined);
    expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stream: "run_status",
        data: expect.objectContaining({
          phase: "retrying",
          attempt: 2,
          maxAttempts: 10,
          reason: "rate_limit",
        }),
      }),
    );
  });

  it.each([
    {
      status: 429,
      headers: new Headers({ "retry-after": "7", "retry-after-ms": "8500" }),
      delayMs: 8500,
    },
    { status: 503, headers: { "Retry-After": "7", "retry-after-ms": "335" }, delayMs: 7000 },
    { status: 429, response: { headers: { "retry-after-ms": "8500" } }, delayMs: 8500 },
    { status: 429, message: "Please try again in 11.054s.", delayMs: 11_054 },
    { status: 429, headers: { "retry-after": "7" }, message: "Retry-After: 12", delayMs: 12_000 },
  ])(
    "honors prompt-exception pacing for HTTP $status with floor $delayMs",
    async ({ status, headers, response, message, delayMs }) => {
      vi.mocked(sleepWithAbort).mockClear();
      const error =
        headers instanceof Headers
          ? new APIError(
              status,
              { message: "provider temporarily unavailable" },
              undefined,
              headers,
            )
          : Object.assign(new Error(message ?? "provider temporarily unavailable"), {
              status,
              headers,
              response,
            });
      const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
        terminal: { kind: "failed", source: "prompt", error },
        errorBody: JSON.stringify({ headers: { "retry-after": "99" } }),
      });
      expect(recovery.action).toBe("retry");
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(delayMs, undefined);
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    },
  );

  it.each([30_000, 65 * 60_000])("honors a Retry-After HTTP date %i ms ahead", async (delayMs) => {
    const nowMs = Date.parse("2026-06-11T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      vi.mocked(sleepWithAbort).mockClear();
      const { recovery } = await recoverAfterTransportDrop({
        errorMessage: `429 rate_limit_exceeded; Retry-After: ${new Date(nowMs + delayMs).toUTCString()}`,
      });
      expect(recovery.action).toBe("retry");
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(delayMs, undefined);
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves the larger header floor after an SDK failure becomes an assistant message", async () => {
    vi.mocked(sleepWithAbort).mockClear();
    const projection = projectProviderError(
      new APIError(
        429,
        { message: "Please try again in 1s." },
        undefined,
        new Headers({ "retry-after": "7", "retry-after-ms": "335" }),
      ),
    );
    const { recovery } = await recoverAfterTransportDrop(projection);
    expect(recovery.action).toBe("retry");
    expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(7000, undefined);
  });

  it("exhausts ten rate-limited attempts before profile rotation and model failover", async () => {
    const fixture = await recoverAfterTransportDrop({
      errorMessage: "429 provider rate limit",
      diagnostics: [],
      content: [],
      replaySafe: true,
    });
    const { failoverRetryController: failover, attempt, erroredAssistant: assistant } = fixture;
    expect(fixture.recovery.action).toBe("retry");
    for (let retry = 2; retry <= 9; retry++) {
      expect((await fixture.recover()).action).toBe("retry");
    }
    expect(failover.advanceAuthProfile).not.toHaveBeenCalled();
    expect(await fixture.recover()).toEqual({ action: "proceed" });
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledTimes(9);
    expect(fixture.onAgentEvent.mock.calls.map(([event]) => event.data.attempt)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    await expect(
      handleEmbeddedAssistantFailure({
        runParams: {
          sessionId: "session:transport-drop",
          runId: "run:transport-drop",
          workspaceDir: "/tmp/provider-recovery-test",
          prompt: "Continue",
          timeoutMs: 60_000,
        },
        attempt,
        attemptAssistant: assistant,
        currentAttemptAssistant: assistant,
        terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        provider: "openai",
        providerOwner: undefined,
        modelId: "gpt-5.6-luna",
        model: "gpt-5.6-luna",
        thinkLevel: "off",
        getThinkLevel: () => "off",
        attemptedThinking: new Set(["off"]),
        fallbackConfigured: true,
        pluginHarnessOwnsTransport: false,
        authProfileStore: { version: 1, profiles: {} },
        runtimeAuthRetry: false,
        maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
        failover,
        emptyErrorRetries: 0,
        overloadProfileRotations: 0,
        previousRetryFailoverReason: "rate_limit",
        traceAttempts: [],
        suspendForFailure: vi.fn(),
        suspensionSessionId: "session:transport-drop",
        agentDir: "/tmp/provider-recovery-test",
        isProbeSession: false,
      }),
    ).rejects.toMatchObject({ name: "FailoverError", reason: "rate_limit", status: 429 });
    expect(failover.advanceAuthProfile).toHaveBeenCalledOnce();
  });

  it("continues from the transcript after a transient transport drop on a settled exec batch", async () => {
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
    } = await recoverAfterTransportDrop();

    expect(recovery).toMatchObject({ action: "retry" });
    expect(failoverRetryController.transientRetryCount).toBe(1);
    expect(markOwnedTranscriptRetry).toHaveBeenCalledTimes(1);
    expect(continueFromCurrentTranscript).toHaveBeenCalledTimes(1);
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("continues after a transient transport drop on a settled failed-tool batch", async () => {
    const { recovery, markOwnedTranscriptRetry, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop({
        failedToolCallId: "call_2",
        lastToolError: { toolName: "exec", error: "command failed" },
      });

    expect(recovery).toMatchObject({ action: "retry" });
    expect(markOwnedTranscriptRetry).toHaveBeenCalledTimes(1);
    expect(continueFromCurrentTranscript).toHaveBeenCalledWith({
      includeToolFailureInstruction: true,
    });
  });

  it.each([0, 1])(
    "continues a parked Code Mode run from its persisted waiting result with activeCount=%i",
    async (activeCount) => {
      const { recovery, markOwnedTranscriptRetry, continueFromCurrentTranscript } =
        await recoverAfterTransportDrop({
          codeModeSuspended: true,
          activeCount,
        });

      expect(recovery).toMatchObject({ action: "retry" });
      expect(markOwnedTranscriptRetry).toHaveBeenCalledTimes(1);
      expect(continueFromCurrentTranscript).toHaveBeenCalledTimes(1);
    },
  );

  it.each<[string, TransportDropScenario]>([
    ["tools have uncertain outcomes", { activeCount: 1 }],
    [
      "the failed tool summary does not match the settled batch",
      {
        failedToolCallId: "call_2",
        lastToolError: { toolName: "write", error: "write failed" },
      },
    ],
    [
      "the failed tool batch is parked but not fully settled",
      {
        activeCount: 1,
        codeModeSuspended: true,
        failedToolCallId: "call_2",
        lastToolError: { toolName: "exec", error: "command failed" },
      },
    ],
    [
      "the failure is retryable but not a transport drop",
      { errorMessage: "429 rate limit exceeded; retry after 2 seconds", diagnostics: [] },
    ],
    [
      "the errored turn already carried visible text",
      { content: [{ type: "text", text: "Partial" }] },
    ],
    [
      "Codex reports a terminal provider prompt error",
      {
        terminal: {
          kind: "failed",
          source: "prompt",
          error: Object.assign(
            new Error("Rate limit reached on tokens per min (TPM). Please try again in 2s."),
            { status: 429 },
          ),
        },
        diagnostics: [],
      },
    ],
  ])("continues the existing transcript when %s", async (_label, scenario) => {
    const { recovery, markOwnedTranscriptRetry, continueFromCurrentTranscript, onAgentEvent } =
      await recoverAfterTransportDrop(scenario);

    expect(recovery).toMatchObject({ action: "retry" });
    expect(markOwnedTranscriptRetry).toHaveBeenCalledOnce();
    expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "run_status",
        data: expect.objectContaining({ phase: "retrying", retryAttempt: 1 }),
      }),
    );
  });

  it.each<[string, TransportDropScenario]>([
    ["the run was externally aborted", { terminal: { kind: "aborted", source: "external" } }],
    ["the run timed out", { terminal: { kind: "timeout", phase: "prompt", source: "runtime" } }],
    ["the attempt yielded", { yieldDetected: true }],
    ["the assistant error is not transient", { errorMessage: "invalid request: bad schema" }],
    ["Gateway storage is locked", { errorMessage: "database is locked", diagnostics: [] }],
    ["the provider requires authentication", { errorMessage: "401 unauthorized" }],
    [
      "the provider has exhausted its quota",
      { errorMessage: "429 insufficient_quota: current quota exhausted", diagnostics: [] },
    ],
    ["the continuation budget is spent", { retryAvailable: false }],
  ])("keeps the replay gate closed when %s", async (_label, scenario) => {
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
    } = await recoverAfterTransportDrop(scenario);

    expect(recovery).toEqual({ action: "proceed" });
    expect(failoverRetryController.transientRetryCount).toBe(0);
    expect(markOwnedTranscriptRetry).not.toHaveBeenCalled();
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
  });

  it("surfaces before_agent_run blocks with current carried usage", async () => {
    const historicalAssistant = buildEmbeddedRunnerAssistant({
      usage: createMockUsage(128_814, 3_000),
    });
    const carriedUsage = normalizeUsage(createMockUsage(42_000, 1_000));
    if (!carriedUsage) {
      throw new Error("expected normalized usage fixture");
    }
    const attempt = makeEmbeddedRunnerAttempt({
      modelAttempt: {
        provider: "openai",
        model: "gpt-5.6-luna",
        credentialSource: {
          kind: "direct",
          evidence: "environment",
          authorization: "ambient",
        },
      },
      terminal: {
        kind: "failed",
        source: "hook:before_agent_run",
        error: new Error("Blocked by before-run policy."),
      },
      lastAssistant: historicalAssistant,
      currentAttemptAssistant: undefined,
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: historicalAssistant,
    });
    const setTerminalLifecycleMeta = vi.fn();

    const recovery = await recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          sessionId: "session:hook-block",
          runId: "run:hook-block",
        },
        resolvedSessionKey: "agent:main:hook-block",
        startedAtMs: Date.now(),
      },
      preparedRuntime: {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        model: { id: "gpt-5.6-luna" },
        genericCompactionRecoveryAllowed: false,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "codex" },
          outerContextTokenMeta: {},
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: historicalAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
        terminalState,
        setTerminalLifecycleMeta,
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        resolveReplayInvalidForAttempt: () => false,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: carriedUsage,
    } as never);

    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: false,
      livenessState: "blocked",
    });
    expect(recovery).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: "Blocked by before-run policy.", isError: true }],
        meta: {
          finalAssistantVisibleText: "Blocked by before-run policy.",
          finalAssistantRawText: "Blocked by before-run policy.",
          error: {
            kind: "hook_block",
            message: "Blocked by before-run policy.",
          },
          livenessState: "blocked",
          agentMeta: {
            credentialSource: {
              kind: "direct",
              evidence: "environment",
              authorization: "ambient",
            },
            lastCallUsage: { input: 42_000, output: 1_000, total: 43_000 },
            promptTokens: 42_000,
          },
        },
      },
    });
  });

  it("bypasses prompt failover for an operation-scoped compaction failure", async () => {
    const promptFailover = vi.fn(async () => {
      throw new Error("prompt failover must not run");
    });
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-read", name: "read", arguments: {} }],
    });
    const messagesSnapshot = [
      assistant,
      { role: "toolResult", toolCallId: "tool-read", toolName: "read", isError: false },
    ] as never;
    const failoverRetryController = {
      resolveAuthProfileFailureReason: vi.fn(),
      advanceAuthProfile: vi.fn(),
      advanceRateLimitAuthProfile: vi.fn(),
      maybeMarkAuthProfileFailure: vi.fn(),
      maybeRetryTransient: vi.fn(),
      transientRetryCount: 0,
    };
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: {
        kind: "failed",
        source: "compaction",
        error: new Error("unexpected status 404"),
      },
      messagesSnapshot,
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      settledTurnFinalizationContext: {
        source: "openclaw-transcript",
        messages: messagesSnapshot,
      },
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });

    const recovery = await recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          config: {},
          agentId: "main",
          sessionId: "session:compaction-failure",
          runId: "run:compaction-failure",
        },
        resolvedSessionKey: "agent:main:compaction-failure",
        startedAtMs: Date.now(),
      },
      preparedRuntime: {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        model: { id: "gpt-5.6-luna" },
        genericCompactionRecoveryAllowed: false,
        maybeRefreshRuntimeAuthForAuthError: promptFailover,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "codex" },
          outerContextTokenMeta: {},
          lastProfileId: "profile-1",
          pluginHarnessOwnsTransport: false,
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: undefined,
        terminalState,
        setTerminalLifecycleMeta: vi.fn(),
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        resolveReplayInvalidForAttempt: () => false,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
      failoverRetryController,
      compactionRuntime: disabledCompactionRuntime,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      usageAccumulator: createUsageAccumulator(),
      lastRunPromptUsage: undefined,
      runtimeAuthRetry: false,
      codexAppServerRecoveryRetryAvailable: false,
      codexAppServerRecoveryRetries: 0,
      lastRetryFailoverReason: null,
      traceAttempts: [],
      sessionAgentId: "main",
    } as never);

    expect(recovery).toEqual({ action: "proceed" });
    expect(promptFailover).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });
});
