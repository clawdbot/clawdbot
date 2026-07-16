import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

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

import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";

function createTurn(config: AgentTurnParams["followupRun"]["run"]["config"]): AgentTurnParams {
  return {
    commandBody: "continue the fallback task",
    followupRun: {
      prompt: "continue the fallback task",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
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
      shouldStartOnReasoning: false,
      signalExecutionActivity: async () => undefined,
      signalMessageStart: async () => undefined,
      signalReasoningDelta: async () => undefined,
      signalRunStart: async () => undefined,
      signalTextDelta: async () => undefined,
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

describe("runEmbeddedFallbackCandidate continuation callbacks", () => {
  it("binds callbacks to the selected fallback provider, model, and auth profile", async () => {
    const config = {
      agents: { defaults: { continuation: { enabled: true } } },
    };
    mocks.compactEmbeddedAgentSession.mockClear();
    mocks.releaseQueuedCompactionTolerant.mockClear();
    mocks.runEmbeddedAgent.mockImplementationOnce(async (options: RunEmbeddedAgentParams) => {
      options.continueWorkOpts?.requestContinuation({
        reason: "continue after fallback",
        delaySeconds: 5,
      });
      await options.requestCompactionOpts?.triggerCompaction({
        trigger: "volitional",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      });
      return { payloads: [{ text: "done" }], meta: {} };
    });

    const result = await runEmbeddedFallbackCandidate({
      turn: createTurn(config),
      effectiveRun: createTurn(config).followupRun.run,
      candidateRun: createTurn(config).followupRun.run,
      runtimeConfig: config,
      provider: "openai",
      model: "gpt-5.6-luna",
      candidateFastMode: {},
      runId: "run-fallback",
      getLifecycleGeneration: () => "generation-1",
      onLifecycleGeneration: vi.fn(),
      suppressQueuedUserPersistenceForCandidate: false,
      suppressAssistantErrorPersistenceForCandidate: false,
      onAssistantErrorMessagePersisted: vi.fn(),
      userTurnTranscriptRecorder: undefined,
      notifyUserMessagePersisted: vi.fn(),
      fastModeStartedAtMs: Date.now(),
      fastModeAutoProgressState: { offAnnounced: false, resetAnnounced: false },
      bootstrapContextRunKind: "default",
      bootstrapPromptWarningSignaturesSeen: [],
      currentTurnImages: { images: undefined, imageOrder: undefined },
      signalExecutionPhaseForTyping: vi.fn(),
      notifyAgentRunStart: vi.fn(),
      notifyUserAboutCompaction: false,
      sourceRepliesAreToolOnly: false,
      messageToolDeliveryState: { toolCallIds: new Set(), completed: false },
      preserveProgressCallbackStartOrder: false,
      presentation: {
        normalizeStreamingText: () => ({ skip: true }),
        preparePartialForTyping: () => undefined,
        handlePartialForTyping: async () => undefined,
        startPresentationWhileTyping: async () => undefined,
        blockReplyHandler: undefined,
      },
      timing: {
        logMilestoneIfSlow: vi.fn(),
        measure: async (_name, run) => await run(),
      } as never,
      onLifecycleBackstop: vi.fn(),
      onCompactionCount: vi.fn(),
    });

    expect(mocks.compactEmbeddedAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        authProfileId: "openai:fallback-auth",
      }),
    );
    expect(mocks.releaseQueuedCompactionTolerant).toHaveBeenCalledOnce();
    expect(result.continueWorkRequests).toEqual([
      { reason: "continue after fallback", delaySeconds: 5 },
    ]);
  });
});
