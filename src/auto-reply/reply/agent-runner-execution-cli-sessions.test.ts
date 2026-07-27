import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  createTestUserTurnRecorder,
  requireRecord,
  requireMockCall,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: CLI session routing", () => {
  it("forwards the static extra system prompt to CLI backends", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.extraSystemPrompt = "dynamic inbound metadata\n\nstable group prompt";
    followupRun.run.extraSystemPromptStatic = "stable group prompt";
    followupRun.run.senderId = "sender-static";
    followupRun.run.senderName = "Sender Static";
    followupRun.run.senderUsername = "sender-static-user";
    followupRun.run.senderE164 = "+15550002222";
    followupRun.run.execOverrides = { host: "node", node: "mac-a" };
    followupRun.run.bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "full",
    };
    followupRun.run.groupId = "group-static";
    followupRun.run.groupChannel = "ops";
    followupRun.run.groupSpace = "workspace-static";
    followupRun.run.spawnedBy = "agent:main:telegram:group:parent";
    followupRun.run.runtimePolicySessionKey = "agent:main:telegram:default:direct:sender-static";
    followupRun.originatingChannel = "telegram";

    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      modelProvider: "codex-cli",
      extraSystemPrompt: "dynamic inbound metadata\n\nstable group prompt",
      extraSystemPromptStatic: "stable group prompt",
      trigger: "user",
      messageChannel: "telegram",
      messageProvider: "telegram",
      senderId: "sender-static",
      senderName: "Sender Static",
      senderUsername: "sender-static-user",
      senderE164: "+15550002222",
      execOverrides: { host: "node", node: "mac-a" },
      bashElevated: { enabled: true, allowed: true, defaultLevel: "full" },
      groupId: "group-static",
      groupChannel: "ops",
      groupSpace: "workspace-static",
      spawnedBy: "agent:main:telegram:group:parent",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:sender-static",
    });
  });

  it("passes silent empty-reply policy to CLI backends for message-tool-only turns", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", "claude-sonnet-4-6"),
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: SILENT_REPLY_TOKEN }],
      meta: { executionTrace: { fallbackUsed: false } },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-sonnet-4-6";
    followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
    followupRun.run.allowEmptyAssistantReplyAsSilent = true;
    followupRun.originatingChannel = "telegram";

    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "telegram",
          MessageSid: "msg",
          ChatType: "group",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      sourceReplyDeliveryMode: "message_tool_only",
      allowEmptyAssistantReplyAsSilent: true,
      messageChannel: "telegram",
      messageProvider: "telegram",
    });
  });

  it("passes prepared CLI user turns to the runtime persistence boundary", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const preparedUserTurnMessage = {
      role: "user",
      content: "describe this",
      MediaPath: "/tmp/image.png",
      MediaPaths: ["/tmp/image.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    } as never;
    followupRun.userTurnTranscriptRecorder = createTestUserTurnRecorder(preparedUserTurnMessage);
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
      updatedAt: 1,
    };
    const activeSessionStore = { main: sessionEntry };

    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      commandBody: "runtime prompt",
      transcriptCommandBody: "display prompt",
      activeSessionStore,
      storePath: "/tmp/sessions.json",
      getActiveSessionEntry: () => activeSessionStore.main,
    });

    expect(result.kind).toBe("success");
    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI runtime", {
      sessionKey: "main",
      agentId: "agent",
      sessionId: "session",
      suppressNextUserMessagePersistence: false,
      persistAssistantTranscript: true,
      storePath: "/tmp/sessions.json",
    });
    const call = requireMockCall(state.runCliAgentMock, 0, "CLI runtime");
    const callParams = requireRecord(call[0], "CLI runtime");
    expect(callParams.userTurnTranscriptRecorder).toEqual(expect.any(Object));
    expect(requireRecord(callParams.userTurnTranscriptRecorder, "user turn recorder").message).toBe(
      preparedUserTurnMessage,
    );
    expect(callParams.onUserMessagePersisted).toEqual(expect.any(Function));
  });

  it("reuses CLI sessions for room-event turns", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ambient" }],
      meta: {
        agentMeta: {
          sessionId: "existing-cli-session",
          cliSessionBinding: {
            sessionId: "existing-cli-session",
            authProfileId: "profile",
          },
        },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.currentInboundEventKind = "room_event";
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const sessionEntry = {
      cliSessionBindings: {
        "codex-cli": { sessionId: "existing-cli-session" },
      },
    } as unknown as SessionEntry;
    const activeSessionStore = { main: sessionEntry };

    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      currentInboundEventKind: "room_event",
      persistAssistantTranscript: false,
      cliSessionId: "existing-cli-session",
      cliSessionBinding: {
        sessionId: "existing-cli-session",
      },
    });
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("existing-cli-session");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toEqual({
      sessionId: "existing-cli-session",
      authProfileId: "profile",
    });
  });

  it("keeps the first CLI session created by a room-event turn", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ambient" }],
      meta: {
        agentMeta: {
          sessionId: "new-cli-session",
          cliSessionBinding: {
            sessionId: "new-cli-session",
            authProfileId: "profile",
          },
        },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.currentInboundEventKind = "room_event";
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const sessionEntry = {} as unknown as SessionEntry;

    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      currentInboundEventKind: "room_event",
      cliSessionId: undefined,
      cliSessionBinding: undefined,
    });
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("new-cli-session");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toEqual({
      sessionId: "new-cli-session",
      authProfileId: "profile",
    });
  });

  it("drops replacement room-event CLI sessions when reuse fails", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ambient" }],
      meta: {
        agentMeta: {
          sessionId: "transient-cli-session",
          cliSessionBinding: {
            sessionId: "transient-cli-session",
            authProfileId: "profile",
          },
          clearCliSessionBinding: true,
        },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.currentInboundEventKind = "room_event";
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const sessionEntry = {
      cliSessionBindings: {
        "codex-cli": { sessionId: "existing-cli-session" },
      },
    } as unknown as SessionEntry;
    const activeSessionStore = { main: sessionEntry };

    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      currentInboundEventKind: "room_event",
      cliSessionId: "existing-cli-session",
      cliSessionBinding: {
        sessionId: "existing-cli-session",
      },
    });
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toBeUndefined();
    expect(result.runResult.meta?.agentMeta?.clearCliSessionBinding).toBeUndefined();
    expect(activeSessionStore.main.cliSessionBindings?.["codex-cli"]).toBeUndefined();
  });

  it("keeps room-event CLI bindings when synthetic hooks return no CLI binding", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "handled" }],
      meta: {
        agentMeta: {
          sessionId: "openclaw-session",
          provider: "codex-cli",
          model: "gpt-5.4",
        },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.currentInboundEventKind = "room_event";
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const sessionEntry = {
      cliSessionBindings: {
        "codex-cli": { sessionId: "existing-cli-session" },
      },
    } as unknown as SessionEntry;
    const activeSessionStore = { main: sessionEntry };

    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toBeUndefined();
    expect(activeSessionStore.main.cliSessionBindings?.["codex-cli"]).toEqual({
      sessionId: "existing-cli-session",
    });
  });

  it("clears room-event CLI bindings when an unflushed replacement is dropped", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "handled" }],
      meta: {
        agentMeta: {
          sessionId: "",
          provider: "codex-cli",
          model: "gpt-5.4",
          clearCliSessionBinding: true,
        },
      },
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.currentInboundEventKind = "room_event";
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const sessionEntry = {
      cliSessionBindings: {
        "codex-cli": { sessionId: "existing-cli-session" },
      },
    } as unknown as SessionEntry;
    const activeSessionStore = { main: sessionEntry };

    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      activeSessionStore,
      getActiveSessionEntry: () => sessionEntry,
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("expected success");
    }
    expect(result.runResult.meta?.agentMeta?.sessionId).toBe("");
    expect(result.runResult.meta?.agentMeta?.cliSessionBinding).toBeUndefined();
    expect(result.runResult.meta?.agentMeta?.clearCliSessionBinding).toBeUndefined();
    expect(activeSessionStore.main.cliSessionBindings?.["codex-cli"]).toBeUndefined();
  });
});
