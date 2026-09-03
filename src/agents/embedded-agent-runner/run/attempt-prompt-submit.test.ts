import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { Context, ImageContent } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { readBtwTranscriptMessages } from "../../btw-transcript.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createOverflowAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "../../sessions/agent-session-loop-resource-loader.test-support.js";
import { agentSessionQueuePromptContext } from "../../sessions/agent-session-prompting.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
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
import {
  buildRuntimeContextCustomMessage,
  type RuntimeContextCustomMessage,
} from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();

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
    [agentSessionQueuePromptContext]: vi.fn(() => () => undefined),
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
  it.each(["handled", "rejected"] as const)(
    "retires queued context when prompt preflight is %s",
    async (outcome) => {
      let calls = 0;
      const handlers = new Map<string, Array<() => Promise<unknown>>>([
        [
          "input",
          [
            async () => {
              if (calls++ === 0 && outcome === "handled") {
                return { action: "handled" };
              }
              return { action: "continue" };
            },
          ],
        ],
      ]);
      streamMocks.streamSimple.mockImplementation((model) =>
        createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }])),
      );
      const { session, sessionManager, modelRegistry } = await createTestSession({
        resourceLoader: createResourceLoader(handlers),
      });
      const authCheck = vi.spyOn(modelRegistry, "hasConfiguredAuth");
      if (outcome === "rejected") {
        authCheck.mockReturnValueOnce(false);
      }
      const submit = (text: string) =>
        submitEmbeddedAttemptPrompt({
          ...createBaseInput(),
          activeSession: session,
          appendOnlyRuntimeContext: true,
          transcriptPrompt: text,
          modelPrompt: text,
          runtimeContextMessage: buildRuntimeContextCustomMessage(`context for ${text}`),
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
        });
      if (outcome === "rejected") {
        await expect(submit("discarded")).rejects.toThrow("No API key");
      } else {
        await submit("discarded");
      }
      authCheck.mockRestore();
      await submit("accepted");
      const carriers = sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom_message");
      expect(carriers).toHaveLength(1);
      expect(carriers[0]).toMatchObject({
        content: expect.stringContaining("context for accepted"),
      });
      expect(JSON.stringify(session.messages)).not.toContain("context for discarded");
    },
  );

  it.each(["append-only", "transient", "none"] as const)(
    "reuses a persisted turn with %s retry context",
    async (retryContext) => {
      const sessionManager = SessionManager.inMemory();
      const user = {
        role: "user" as const,
        content: "transcript prompt",
        timestamp: 1,
        idempotencyKey: "same-turn",
      };
      sessionManager.appendMessage(user);
      const carrier = buildRuntimeContextCustomMessage("original context")!;
      sessionManager.appendCustomMessageEntry(
        carrier.customType,
        carrier.content,
        carrier.display,
        carrier.details,
      );
      const recorder = createUserTurnTranscriptRecorder({
        message: user,
        target: async () => undefined,
      });
      recorder.markRuntimePersisted(user);
      const requests: Context["messages"][] = [];
      streamMocks.streamSimple.mockImplementation((model, context) => {
        requests.push(structuredClone(context.messages));
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "retried" }]),
        );
      });
      const { session } = await createTestSession({ sessionManager });
      await prepareEmbeddedAttemptSessionBoundary({
        activeSession: session,
        appendOnlyRuntimeContext: retryContext !== "transient",
        attempt: { prompt: user.content, userTurnTranscriptRecorder: recorder },
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: user,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });
      await submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        attempt: { sessionId, userTurnTranscriptRecorder: recorder },
        activeSession: session,
        appendOnlyRuntimeContext: retryContext !== "transient",
        appendContext: undefined,
        prependContext: undefined,
        modelPrompt: user.content,
        runtimeContextMessage:
          retryContext === "none" ? undefined : buildRuntimeContextCustomMessage("rebuilt context"),
        promptActiveSession: (prompt, options) => session.prompt(prompt, options),
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toHaveLength(2);
      expect(requests[0]![0]).toMatchObject({
        role: "user",
        content: expect.stringContaining(user.content),
      });
      expect(requests[0]![1]).toMatchObject({
        role: "user",
        content: [
          {
            type: "text",
            text:
              retryContext === "transient"
                ? buildRuntimeContextCustomMessage("rebuilt context")!.content
                : carrier.content,
          },
        ],
      });
      expect(
        sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
      ).toHaveLength(1);
    },
  );

  it("does not duplicate a persisted carrier when overflow compacts its turn", async () => {
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(
        requests.length === 1
          ? createOverflowAssistant(model)
          : createAssistant(model, [{ type: "text", text: "recovered" }]),
      );
    });
    const handlers = createCompactionHandlers();
    handlers.set("session_before_compact", [
      async (event: unknown) => {
        const { preparation } = event as {
          preparation: { firstKeptEntryId: string; tokensBefore: number };
        };
        return { compaction: { summary: "condensed history", ...preparation } };
      },
    ]);
    const { session, sessionManager } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(handlers),
    });
    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession: session,
      appendOnlyRuntimeContext: true,
      appendContext: undefined,
      prependContext: undefined,
      modelPrompt: "transcript prompt",
      runtimeContextMessage: buildRuntimeContextCustomMessage("stable overflow context"),
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]![1]).toMatchObject({ role: "user", runtimeContextCarrier: true });
    expect(JSON.stringify(requests[1])).toContain("condensed history");
    expect(
      requests[1]!.filter((message) => message.role === "user" && message.runtimeContextCarrier),
    ).toHaveLength(0);
    expect(
      sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(1);
    expect(session.getLastAssistantText()).toBe("recovered");
  });

  it.each([false, true])(
    "persists runtime context only for append-only replay (%s), once across retry and reopen",
    async (appendOnlyRuntimeContext) => {
      await withOpenClawTestState({ label: "runtime-context-persistence" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:runtime-context-persistence",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
        });
        const requests: Context["messages"][] = [];
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(structuredClone(context.messages));
          return createAssistantResultStream(
            requests.length === 1
              ? { ...createAssistant(model, [], "error"), errorMessage: "503 overloaded" }
              : createAssistant(model, [{ type: "text", text: "done" }]),
          );
        });
        const first = await createTestSession({
          sessionManager: SessionManager.open(target, state.workspaceDir),
          settingsManager,
        });
        if (appendOnlyRuntimeContext) {
          await first.session.sendCustomMessage(
            { customType: "test.extension-context", content: "extension context", display: false },
            { deliverAs: "nextTurn" },
          );
        }
        const submit = async (session: typeof first.session, text: string) => {
          const input = createBaseInput();
          await submitEmbeddedAttemptPrompt({
            ...input,
            activeSession: session,
            appendOnlyRuntimeContext,
            appendContext: undefined,
            prependContext: undefined,
            transcriptPrompt: text,
            modelPrompt: text,
            runtimeContextMessage: buildRuntimeContextCustomMessage(`context for ${text}`),
            promptActiveSession: (prompt, options) =>
              session.prompt(prompt, { ...options, expandPromptTemplates: false }),
          });
        };
        await submit(first.session, "first");
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);

        const reopenedManager = SessionManager.open(target, state.workspaceDir);
        const reopened = await createTestSession({
          sessionManager: reopenedManager,
          settingsManager,
        });
        await submit(reopened.session, "second");
        expect(requests).toHaveLength(3);
        const entries = reopenedManager.getEntries();
        const carriers = entries.filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "openclaw.runtime-context",
        );
        expect(carriers).toHaveLength(appendOnlyRuntimeContext ? 2 : 0);
        if (appendOnlyRuntimeContext) {
          for (const carrier of carriers) {
            expect(carrier).toMatchObject({ display: false });
            const previous = entries[entries.indexOf(carrier) - 1];
            expect(previous).toMatchObject({ type: "message", message: { role: "user" } });
          }
          // Timestamps are local metadata; provider-visible content and order must replay unchanged.
          const providerPrefix = (messages: Context["messages"]) =>
            messages.map(({ role, content }) => ({ role, content }));
          expect(providerPrefix(requests[2]!.slice(0, requests[0]!.length))).toEqual(
            providerPrefix(requests[0]!),
          );
          expect(requests[0]![1]).toMatchObject({ role: "user", runtimeContextCarrier: true });
        } else {
          expect(JSON.stringify(requests[2])).not.toContain("context for first");
        }

        reopenedManager.appendResetBoundary("new");
        const reset = await createTestSession({
          sessionManager: SessionManager.open(target, state.workspaceDir),
          settingsManager,
        });
        await submit(reset.session, "after reset");
        expect(JSON.stringify(requests.at(-1))).not.toContain("context for first");
        expect(JSON.stringify(requests.at(-1))).not.toContain("context for second");
        expect(JSON.stringify(requests.at(-1))).toContain("context for after reset");
      });
    },
  );

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
