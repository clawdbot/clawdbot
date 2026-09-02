import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { ImageContent } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { readBtwTranscriptMessages } from "../../btw-transcript.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  beginPromptCacheObservation,
  completePromptCacheObservation,
} from "../prompt-cache-observability.js";
import {
  clearActiveEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  setActiveEmbeddedRun,
} from "../runs.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";

const sessionId = "attempt-prompt-submit-test";
type PromptActiveSession = Parameters<typeof submitEmbeddedAttemptPrompt>[0]["promptActiveSession"];
type PromptOptions = Parameters<PromptActiveSession>[1];

function createSession() {
  const state = {
    messages: [{ role: "user", content: "transcript prompt", timestamp: 1 }] as AgentMessage[],
  };
  const baseStreamFn: StreamFn = () => {
    throw new Error("stream function should not be called directly");
  };
  const originalTransformContext = async (messages: AgentMessage[]) => messages;
  const agent = {
    state,
    streamFn: baseStreamFn,
    transformContext: originalTransformContext,
    reset: () => {
      state.messages = [];
    },
  };
  const activeSession = {
    get messages() {
      return state.messages;
    },
    agent,
  };
  return { activeSession, baseStreamFn, originalTransformContext };
}

function createBaseInput() {
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  return {
    attempt: { sessionId },
    appendContext: "append context",
    contextTokenBudget: 8_000,
    images: [] as ImageContent[],
    modelPrompt: "model prompt",
    onFinalPromptText: vi.fn(),
    onSteeringAcknowledged: vi.fn(),
    prependContext: "prepend context",
    runtimeOnly: false,
    sessionPromptState,
    systemPrompt: "system prompt",
    toolResultAggregateMaxChars: 8_000,
    toolResultMaxChars: 4_000,
    toolResultPromptProjectionState: sessionPromptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: null,
    transcriptPrompt: "transcript prompt",
  };
}

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("submitEmbeddedAttemptPrompt", () => {
  it.each([
    { scenario: "first-turn", excludeCurrentUser: true },
    { scenario: "after-reset", excludeCurrentUser: true },
    { scenario: "after-reset-metadata", excludeCurrentUser: true },
    { scenario: "skipped-prepared", excludeCurrentUser: false },
    { scenario: "raw-probe", excludeCurrentUser: false },
    { scenario: "settled-finalization", excludeCurrentUser: false },
  ])(
    "preserves the pre-turn BTW snapshot boundary: $scenario",
    async ({ scenario, excludeCurrentUser }) => {
      await withOpenClawTestState({ label: "btw-current-user" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: `agent:main:btw-current-user-${scenario}`,
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const sessionManager = SessionManager.open(target, state.workspaceDir);
        if (scenario !== "first-turn") {
          sessionManager.appendMessage({ role: "user", content: "old conversation", timestamp: 1 });
          sessionManager.appendResetBoundary("reset");
        }
        const beforeCurrentUserLeaf = sessionManager.getLeafId();
        const currentUser = {
          role: "user" as const,
          content: "Current main task, not prior conversation",
          idempotencyKey: "btw-current-user:user",
          timestamp: 2,
        };
        const appended = sessionManager.appendMessageWithTranscriptAnchor(currentUser);
        if (!appended.anchor) {
          throw new Error("Expected a persisted current-user admission");
        }
        const recorder = createUserTurnTranscriptRecorder({
          message: currentUser,
          target: () => undefined,
        });
        recorder.markRuntimePersisted(currentUser, appended.anchor);
        const { activeSession } = createSession();
        activeSession.agent.state.messages = sessionManager.buildSessionContext().messages;
        const input = createBaseInput();
        const isRawModelRun = scenario === "raw-probe";
        const isFinalization = scenario === "settled-finalization";
        const attempt = {
          config: {},
          operation: isFinalization ? "settled-tool-finalization" : "attempt",
          skipPreparedUserTurnMessage: isFinalization || scenario === "skipped-prepared",
          model: { id: "test-model", provider: "test-provider", api: "openai-responses" },
          modelId: "test-model",
          provider: "test-provider",
          prompt: currentUser.content,
          runId: "btw-current-user",
          sessionId,
          sessionKey: target.sessionKey,
          sessionTarget: target,
          trigger: "user",
          userTurnTranscriptRecorder: recorder,
          workspaceDir: state.workspaceDir,
        } as Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0]["attempt"];
        await prepareEmbeddedAttemptSessionBoundary({
          activeSession: activeSession as unknown as Parameters<
            typeof prepareEmbeddedAttemptSessionBoundary
          >[0]["activeSession"],
          attempt,
          getUserTranscriptContexts: () => undefined,
          isRawModelRun,
          preparedUserTurnMessage: attempt.skipPreparedUserTurnMessage ? undefined : currentUser,
          sessionManager,
          setActiveSessionSystemPrompt: vi.fn(),
        });
        const expectedSnapshotMessages = isFinalization ? [currentUser] : [];
        expect(activeSession.messages).toEqual(expectedSnapshotMessages);
        expect(sessionManager.getLeafId()).toBe(appended.entryId);
        if (scenario === "after-reset-metadata") {
          sessionManager.appendThinkingLevelChange("low");
        }
        const persistedBefore = loadTranscriptEventsSync(target);
        const handle = {
          runId: attempt.runId,
          queueMessage: async () => undefined,
          isStreaming: () => true,
          isCompacting: () => false,
          abort: () => undefined,
        };
        const admission = prepareSystemAgentRunAdmission(
          {},
          attempt.runId,
          target.agentId,
          "btw-snapshot-test",
        );
        setActiveEmbeddedRun(sessionId, handle, target.sessionKey);
        try {
          attempt.admittedRunContext = await admission.admit("embedded");
          const assembly = await prepareEmbeddedAttemptPromptAssembly({
            attempt,
            activeSession: activeSession as unknown as Parameters<
              typeof prepareEmbeddedAttemptPromptAssembly
            >[0]["activeSession"],
            sessionManager,
            hookRunner: null,
            hookAgentId: "main",
            diagnosticTrace: { traceId: "11111111111111111111111111111111" },
            isRawModelRun,
            sessionAgentId: "main",
            runtimeModel: "test-model",
            systemPromptText: input.systemPrompt,
            applyPromptBuildToolsAllow: () => [],
            setActiveSessionSystemPrompt: vi.fn(),
            setLeasedSteering: vi.fn(),
            cache: {
              observabilityEnabled: false,
              retention: "none",
              streamStrategy: "default",
              transport: "sse",
              tools: [],
              trace: null,
            },
          });
          await submitEmbeddedAttemptPrompt({
            ...input,
            attempt,
            activeSession,
            transcriptLeafId: assembly.transcriptLeafId,
            transcriptPrompt: currentUser.content,
            modelPrompt: currentUser.content,
            promptActiveSession: async () => undefined,
          });
          const snapshot = getActiveEmbeddedRunSnapshot(sessionId);
          if (!snapshot) {
            throw new Error("Expected the submitted main-run snapshot");
          }
          expect(snapshot.messages).toEqual(expectedSnapshotMessages);
          expect(snapshot.inFlightPrompt).toBe(currentUser.content);
          const messages = await readBtwTranscriptMessages({
            ...target,
            sessionFile: target.sessionKey,
            snapshotLeafId: snapshot.transcriptLeafId,
          });
          expect(messages).toEqual(excludeCurrentUser ? [] : [currentUser]);
          expect(snapshot.transcriptLeafId).toBe(
            excludeCurrentUser ? beforeCurrentUserLeaf : sessionManager.getLeafId(),
          );
          expect(loadTranscriptEventsSync(target)).toEqual(persistedBefore);
        } finally {
          admission.close();
          clearActiveEmbeddedRun(sessionId, handle, target.sessionKey);
          forgetPromptBuildDrainCacheForRun(attempt.runId);
        }
      });
    },
  );

  it.each([
    { skipPreparedUserTurnMessage: false, expectedKey: "persisted-current-user" },
    { skipPreparedUserTurnMessage: true, expectedKey: undefined },
  ])(
    "passes persisted user identity when prepared-user skipping is $skipPreparedUserTurnMessage",
    async ({ skipPreparedUserTurnMessage, expectedKey }) => {
      const { activeSession } = createSession();
      const input = createBaseInput();
      const persistedUser = {
        role: "user" as const,
        content: "transcript prompt",
        idempotencyKey: "persisted-current-user",
        timestamp: 1,
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: persistedUser,
        target: async () => undefined,
      });
      recorder.markRuntimePersisted(persistedUser);
      const promptActiveSession = vi.fn(
        async (_prompt: string, _options?: PromptOptions) => undefined,
      );

      await submitEmbeddedAttemptPrompt({
        ...input,
        attempt: {
          sessionId,
          skipPreparedUserTurnMessage,
          userTurnTranscriptRecorder: recorder,
        },
        activeSession,
        promptActiveSession,
      });

      const promptOptions = promptActiveSession.mock.calls[0]?.[1];
      if (expectedKey) {
        expect(promptOptions).toMatchObject({ persistedUserIdempotencyKey: expectedKey });
      } else {
        expect(promptOptions).not.toHaveProperty("persistedUserIdempotencyKey");
      }
    },
  );

  it("submits runtime-only prompts without images and acknowledges steering", async () => {
    const { activeSession, baseStreamFn, originalTransformContext } = createSession();
    const input = createBaseInput();
    const promptActiveSession = vi.fn(
      async (
        prompt: string,
        options?: { images?: ImageContent[]; preflightResult?: (submitted: boolean) => void },
      ) => {
        expect(prompt).toBe("transcript prompt");
        expect(options).not.toHaveProperty("images");
        expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
        expect(activeSession.agent.streamFn).not.toBe(baseStreamFn);
        expect(activeSession.agent.transformContext).not.toBe(originalTransformContext);
        options?.preflightResult?.(true);
      },
    );

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      leasedSteering: { leaseId: "lease-1", runIds: ["missing-run"] },
      promptActiveSession,
      runtimeOnly: true,
    });

    expect(input.onSteeringAcknowledged).toHaveBeenCalledOnce();
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
  });

  it("cleans up runtime context and transforms when normal submission fails", async () => {
    const { activeSession, baseStreamFn, originalTransformContext } = createSession();
    const input = createBaseInput();
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const runtimeContextMessage: RuntimeContextCustomMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "runtime context",
      display: false,
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
      timestamp: 2,
    };
    const promptActiveSession = vi.fn(
      async (
        _prompt: string,
        options?: { images?: ImageContent[]; preflightResult?: (submitted: boolean) => void },
      ) => {
        expect(activeSession.messages).toContain(runtimeContextMessage);
        expect(options?.images).toEqual([image]);
        options?.preflightResult?.(true);
        throw new Error("provider failed");
      },
    );

    await expect(
      submitEmbeddedAttemptPrompt({
        ...input,
        activeSession,
        images: [image],
        promptActiveSession,
        runtimeContextMessage,
      }),
    ).rejects.toThrow("provider failed");

    expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
    expect(input.onSteeringAcknowledged).not.toHaveBeenCalled();
    expect(activeSession.messages).not.toContain(runtimeContextMessage);
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
  });

  it("caps oversized MCP tool results at the provider boundary", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const oversized = "x".repeat(5 * 1024 * 1024);
    const small = "small MCP result";
    activeSession.agent.state.messages = [
      { role: "user", content: "call MCP tools", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "mcp-huge-call",
        toolName: "huge__return_text",
        content: [{ type: "text", text: oversized }],
        isError: false,
        details: { mcpServer: "huge", mcpTool: "return_text" },
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "mcp-small-call",
        toolName: "huge__small_text",
        content: [{ type: "text", text: small }],
        isError: false,
        details: { mcpServer: "huge", mcpTool: "small_text" },
        timestamp: 3,
      },
    ] as AgentMessage[];
    let providerMessages: AgentMessage[] = [];
    activeSession.agent.streamFn = ((_model, context) => {
      providerMessages = (context as { messages: AgentMessage[] }).messages;
      return undefined as never;
    }) as StreamFn;

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: async () => {
        await activeSession.agent.streamFn(
          {} as never,
          { messages: activeSession.messages } as never,
          {} as never,
        );
      },
    });

    type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
    const hugeResult = providerMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "mcp-huge-call",
    );
    const smallResult = providerMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "mcp-small-call",
    );
    expect(hugeResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/more characters truncated/),
    });
    expect(hugeResult?.content[0]?.type === "text" ? hugeResult.content[0].text.length : 0).toBe(
      input.toolResultMaxChars,
    );
    expect(smallResult?.content).toEqual([{ type: "text", text: small }]);
    const originalHugeResult = activeSession.messages[1];
    expect(originalHugeResult?.role).toBe("toolResult");
    expect(
      originalHugeResult?.role === "toolResult" ? originalHugeResult.content : undefined,
    ).toEqual([{ type: "text", text: oversized }]);
  });

  it("records aggregate truncation on a provider-bound cache break", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const promptCacheKey = `${sessionId}:aggregate-truncation`;
    const observation = {
      sessionId,
      promptCacheKey,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: input.systemPrompt,
      tools: [],
    } as const;
    beginPromptCacheObservation(observation);
    completePromptCacheObservation({
      sessionId,
      promptCacheKey,
      usage: { cacheRead: 8_000 },
    });
    beginPromptCacheObservation(observation);
    activeSession.agent.state.messages = [
      { role: "user", content: "call tools", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "aggregate-a",
        toolName: "read",
        content: [{ type: "text", text: "a".repeat(6_000) }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "aggregate-b",
        toolName: "read",
        content: [{ type: "text", text: "b".repeat(6_000) }],
        isError: false,
        timestamp: 3,
      },
      // Real dispatch pins a non-tool carrier after tool results, so the fresh
      // batch is not trailing-protected and aggregate recovery can engage.
      { role: "user", content: "continue", timestamp: 4 },
    ] as AgentMessage[];
    activeSession.agent.streamFn = (() => undefined as never) as StreamFn;

    await submitEmbeddedAttemptPrompt({
      ...input,
      attempt: { sessionId, promptCacheKey },
      activeSession,
      toolResultAggregateMaxChars: 6_000,
      promptActiveSession: async () => {
        await activeSession.agent.streamFn(
          {} as never,
          { messages: activeSession.messages } as never,
          {} as never,
        );
      },
    });

    expect(
      completePromptCacheObservation({
        sessionId,
        promptCacheKey,
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: [
        {
          code: "aggregateToolResultTruncation",
          detail: "aggregate tool-result truncation changed provider prompt",
        },
      ],
    });
  });
});
