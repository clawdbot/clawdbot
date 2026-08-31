import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { normalizeUsage } from "../../usage.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { recoverEmbeddedRunAttempt } from "./attempt-recovery.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

type TransportDropScenario = {
  errorMessage?: string;
  content?: AssistantMessage["content"];
  diagnostics?: AssistantMessage["diagnostics"];
  activeCount?: number;
  codeModeSuspended?: boolean;
  failedToolCallId?: string;
  lastToolError?: Parameters<typeof makeEmbeddedRunnerAttempt>[0]["lastToolError"];
  transportDropContinuations?: number;
  terminal?: Parameters<typeof makeEmbeddedRunnerAttempt>[0]["terminal"];
  yieldDetected?: boolean;
};

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
    lastToolError: scenario.lastToolError,
    itemLifecycle: {
      startedCount: toolCalls.length,
      completedCount: toolCalls.length,
      activeCount: scenario.activeCount ?? 0,
    },
    ...(scenario.terminal ? { terminal: scenario.terminal } : {}),
    ...(scenario.yieldDetected ? { yieldDetected: true } : {}),
  });
  const terminalState = resolveEmbeddedRunAttemptTerminalState({
    attempt,
    assistant: erroredAssistant,
  });
  const markOwnedTranscriptRetry = vi.fn();
  const continueFromCurrentTranscript = vi.fn();
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  contextRecoveryState.transportDropContinuations = scenario.transportDropContinuations ?? 0;
  const failoverRetryController = {
    resolveAuthProfileFailureReason: vi.fn(),
    advanceAuthProfile: vi.fn(),
    advanceRateLimitAuthProfile: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(),
    maybeBackoffBeforeOverloadFailover: vi.fn(),
  };
  const recovery = await recoverEmbeddedRunAttempt({
    runInput: {
      runParams: {
        config: {},
        agentId: "main",
        sessionId: "session:transport-drop",
        runId: "run:transport-drop",
      },
      resolvedSessionKey: "agent:main:transport-drop",
      startedAtMs: Date.now(),
      laneController: { throwIfAborted: vi.fn() },
    },
    preparedRuntime: {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      model: { id: "gpt-5.6-luna" },
      genericCompactionRecoveryAllowed: false,
      snapshot: () => ({
        thinkLevel: "off",
        agentHarness: { id: "openclaw" },
        outerContextTokenMeta: {},
        pluginHarnessOwnsTransport: false,
      }),
    },
    normalizedAttempt: {
      attempt,
      sessionIdUsed: attempt.sessionIdUsed,
      attemptAssistant: erroredAssistant,
      currentAttemptAssistant: erroredAssistant,
      currentAttemptCompletedAssistant: undefined,
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
    compactionRuntime: disabledCompactionRuntime,
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
  return {
    recovery,
    markOwnedTranscriptRetry,
    continueFromCurrentTranscript,
    contextRecoveryState,
    failoverRetryController,
  };
}

describe("recoverEmbeddedRunAttempt", () => {
  it("continues from the transcript after a transient transport drop on a settled exec batch", async () => {
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      contextRecoveryState,
      failoverRetryController,
    } = await recoverAfterTransportDrop();

    expect(recovery).toMatchObject({ action: "retry" });
    expect(contextRecoveryState.transportDropContinuations).toBe(1);
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
    ["the exec batch is still running", { activeCount: 1 }],
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
    ["the run was externally aborted", { terminal: { kind: "aborted", source: "external" } }],
    ["the run timed out", { terminal: { kind: "timeout", phase: "prompt", source: "runtime" } }],
    ["the attempt already has terminal state", { yieldDetected: true }],
    ["the assistant error is not transient", { errorMessage: "invalid request: bad schema" }],
    [
      "the failure is retryable but not a transport drop",
      { errorMessage: "429 rate limit exceeded; retry after 2 seconds", diagnostics: [] },
    ],
    [
      "the errored turn already carried visible text",
      { content: [{ type: "text", text: "Partial" }] },
    ],
    ["the continuation budget is spent", { transportDropContinuations: 2 }],
  ])("keeps the replay gate closed when %s", async (_label, scenario) => {
    const { recovery, markOwnedTranscriptRetry, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop(scenario);

    expect(recovery).toEqual({ action: "proceed", shouldSurfaceCodexCompletionTimeout: false });
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
      maybeBackoffBeforeOverloadFailover: vi.fn(),
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

    expect(recovery).toEqual({ action: "proceed", shouldSurfaceCodexCompletionTimeout: false });
    expect(promptFailover).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });
});
