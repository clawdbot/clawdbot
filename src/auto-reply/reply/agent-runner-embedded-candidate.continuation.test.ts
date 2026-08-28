import { describe, expect, it, vi } from "vitest";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createAgentTurnTimingTracker } from "./agent-runner-turn-timing.js";

const mocks = vi.hoisted(() => ({
  compactEmbeddedAgentSession: vi.fn(async () => ({
    ok: true,
    compacted: true,
    result: {},
  })),
  releaseQueuedCompactionTolerant: vi.fn(async () => undefined),
  runEmbeddedAgent: vi.fn(),
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));

vi.mock("../../agents/embedded-agent-runner/compact.queued.js", () => ({
  compactEmbeddedAgentSession: mocks.compactEmbeddedAgentSession,
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: () => ({
    embeddedContext: {
      agentId: "main",
      messageProvider: "discord",
      sessionId: "session-fallback",
      sessionKey: "agent:main:fallback",
    },
    senderContext: {},
    runBaseParams: {
      authProfileId: "openai:fallback-auth",
      sessionFile: "session-fallback.jsonl",
      timeoutMs: 1_000,
      workspaceDir: "/workspace",
    },
  }),
}));

vi.mock("../../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: () => ({ runtime: "openclaw", runtimeSource: "model" }),
}));

vi.mock("../../agents/openai-routing.js", () => ({
  resolveOpenAIRuntimeProvider: () => "openai",
}));

vi.mock("../../gateway/message-action-turn-capability.js", () => ({
  isTrustedMessageActionTurnIngress: () => false,
  mintMessageActionTurnCapability: vi.fn(),
  revokeMessageActionTurnCapability: vi.fn(),
}));

vi.mock("./agent-lifecycle-terminal.js", () => ({
  createAgentLifecycleTerminalBackstop: () => ({
    emit: vi.fn(),
    getDeferredError: () => undefined,
  }),
}));

vi.mock("./agent-runner-event-handler.js", () => ({
  createAgentRunEventHandler: () => vi.fn(),
}));

vi.mock("./agent-runner-post-compaction-release.js", () => ({
  computeRequestCompactionContextUsage: () => 0.75,
  releaseQueuedCompactionTolerant: mocks.releaseQueuedCompactionTolerant,
}));

import { createTestPreparedRunAdmission } from "../../agents/admitted-run-context.test-support.js";
import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";

function createTurn(config: AgentTurnParams["followupRun"]["run"]["config"]): AgentTurnParams {
  return {
    commandBody: "continue the fallback task",
    followupRun: {
      prompt: "continue the fallback task",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/agent",
        sessionId: "session-fallback",
        sessionKey: "agent:main:fallback",
        sessionFile: "session-fallback.jsonl",
        workspaceDir: "/workspace",
        config,
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
        drainsContinuationDelegateQueue: true,
      },
    },
    sessionCtx: {},
    typingSignals: {
      mode: "instant",
      shouldStartImmediately: true,
      shouldStartOnMessageStart: false,
      shouldStartOnText: true,
      shouldStartOnReasoning: false,
      signalExecutionActivity: async () => undefined,
      signalMessageStart: async () => undefined,
      signalReasoningDelta: async () => undefined,
      signalRunStart: async () => undefined,
      signalTextDelta: async () => undefined,
      signalToolStart: async () => undefined,
    },
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    applyReplyToMode: (payload) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => true,
    pendingToolTasks: new Set(),
    resetSessionAfterRoleOrderingConflict: async () => false,
    isHeartbeat: false,
    sessionKey: "agent:main:fallback",
    getActiveSessionEntry: () => ({
      sessionId: "session-fallback",
      updatedAt: 1,
      totalTokens: 75,
      totalTokensFresh: true,
      contextTokens: 100,
    }),
    activeSessionStore: {},
    storePath: "sessions.json",
    resolvedVerboseLevel: "off",
  } as AgentTurnParams;
}

function runCandidate(
  config: AgentTurnParams["followupRun"]["run"]["config"],
  onCompactionCount = vi.fn(),
) {
  return runEmbeddedFallbackCandidate({
    preparedRunAdmission: createTestPreparedRunAdmission("run-test"),
    deferredLifecycle: createDeferredEmbeddedRunLifecycleManager({
      runId: "run-fallback",
      sessionId: "session-fallback",
      sessionKey: "agent:main:fallback",
    }),
    githubPublicationAvailable: false,
    turn: createTurn(config),
    effectiveRun: createTurn(config).followupRun.run,
    candidateRun: createTurn(config).followupRun.run,
    runtimeConfig: config,
    provider: "openai",
    model: "gpt-5.6-luna",
    candidateFastMode: {},
    runLane: "main",
    runId: "run-fallback",
    getLifecycleGeneration: () => "generation-1",
    onLifecycleGeneration: vi.fn(),
    suppressQueuedUserPersistenceForCandidate: false,
    suppressAssistantErrorPersistenceForCandidate: false,
    onAssistantErrorMessagePersisted: vi.fn(),
    userTurnTranscriptRecorder: undefined,
    contextEngineLogicalTurnLease: {} as never,
    onContextEngineTurnCandidate: vi.fn(),
    notifyUserMessagePersisted: vi.fn(),
    fastModeStartedAtMs: Date.now(),
    fastModeAutoProgressState: { offAnnounced: false, resetAnnounced: false },
    bootstrapContextRunKind: "default",
    bootstrapPromptWarningSignaturesSeen: [],
    currentTurnImages: { images: undefined, imageOrder: undefined },
    signalExecutionPhaseForTyping: vi.fn(),
    notifyAgentRunStart: vi.fn(),
    notifyUserAboutCompaction: false,
    // sourceRepliesAreToolOnly is no longer a turn param: upstream derives it
    // from the source-reply delivery runtime / followupRun.run.sourceReplyDeliveryMode.
    // This fixture leaves that mode unset, so the derived value is false —
    // identical to the explicit `false` this object used to carry.
    messageToolDeliveryState: { toolCallIds: new Set(), completed: false },
    preserveProgressCallbackStartOrder: false,
    presentation: {
      classifyStreamingPartial: () => ({ skip: true }),
      sanitizeStreamingText: () => ({ skip: true }),
      normalizeStreamingText: () => ({ skip: true }),
      startPresentationWhileTyping: async () => undefined,
      blockReplyHandler: undefined,
    },
    timing: createAgentTurnTimingTracker(),
    onLifecycleBackstop: vi.fn(),
    onCompactionCount,
  });
}

describe("runEmbeddedFallbackCandidate continuation callbacks", () => {
  it("binds callbacks to the selected fallback provider, model, and auth profile", async () => {
    const config = {
      agents: { defaults: { continuation: { enabled: true } } },
    };
    mocks.compactEmbeddedAgentSession.mockClear();
    mocks.releaseQueuedCompactionTolerant.mockClear();
    const onCompactionCount = vi.fn();
    mocks.runEmbeddedAgent.mockImplementationOnce(async (options: RunEmbeddedAgentParams) => {
      options.continueWorkOpts?.requestContinuation({
        reason: "continue after fallback",
        delaySeconds: 5,
      });
      await options.requestCompactionOpts?.triggerCompaction({
        sessionKey: "agent:main:fallback",
        sessionId: "session-fallback",
        runId: "run-fallback",
        diagId: "diag-fallback",
        trigger: "volitional",
        reason: "test fallback compaction",
        contextUsage: 0.75,
        requestedAtMs: 1,
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      });
      return {
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "session-fallback",
            provider: "openai",
            model: "gpt-5.6-luna",
            compactionCount: 7,
          },
          contextManagement: { lastTurnCompactions: 1 },
          finalAssistantRawText:
            "<final>done\n[[CONTINUE_DELEGATE: inspect wrapped fallback]]</final>",
        },
      };
    });

    const result = await runCandidate(config, onCompactionCount);

    expect(mocks.compactEmbeddedAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        authProfileId: "openai:fallback-auth",
      }),
    );
    expect(mocks.releaseQueuedCompactionTolerant).toHaveBeenCalledOnce();
    expect(onCompactionCount).toHaveBeenCalledOnce();
    expect(onCompactionCount).toHaveBeenCalledWith(1);
    expect(result.continueWorkRequests).toEqual([
      { reason: "continue after fallback", delaySeconds: 5 },
    ]);
    expect(result.rawContinuationText).toBe(
      "done\n[[CONTINUE_DELEGATE: inspect wrapped fallback]]",
    );
  });

  it("does not retain raw continuation text from replay-unsafe incomplete turns", async () => {
    const config = {
      agents: { defaults: { continuation: { enabled: true } } },
    };
    mocks.runEmbeddedAgent.mockResolvedValueOnce({
      payloads: [{ text: "partial" }],
      meta: {
        durationMs: 1,
        finalAssistantRawText: "partial\n[[CONTINUE_DELEGATE: unsafe task]]",
        replayInvalid: true,
        error: {
          kind: "incomplete_turn",
          message: "stream interrupted",
        },
      },
    });

    const result = await runCandidate(config);

    expect(result.rawContinuationText).toBeUndefined();
  });
});
