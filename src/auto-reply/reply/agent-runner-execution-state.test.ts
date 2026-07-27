import { describe, expect, it } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: session state", () => {
  it("restarts the active prompt when a live model switch is requested", async () => {
    let fallbackInvocation = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const isInitialInvocation = fallbackInvocation++ === 0;
        const provider = isInitialInvocation ? "anthropic" : "openai";
        const model = isInitialInvocation ? "claude" : "gpt-5.4";
        return {
          result: await params.run(provider, model),
          provider,
          model,
          attempts: [],
        };
      },
    );
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          agentRuntimeOverride: "codex",
        });
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "switched" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        };
      });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
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
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ agentHarnessRuntimeOverride: "codex" }),
    );
  });

  it("breaks out of the retry loop when LiveSessionModelSwitchError is thrown repeatedly (#58348)", async () => {
    // Simulate a scenario where the persisted session selection keeps conflicting
    // with the fallback model, causing LiveSessionModelSwitchError on every attempt.
    // The outer loop must be bounded to prevent a session death loop.
    let switchCallCount = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        switchCallCount++;
        return {
          result: await params.run("anthropic", "claude"),
          provider: "anthropic",
          model: "claude",
          attempts: [],
        };
      },
    );
    state.runEmbeddedAgentMock.mockImplementation(async () => {
      throw new LiveSessionModelSwitchError({
        provider: "openai",
        model: "gpt-5.4",
      });
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
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

    // After two retries the loop must break instead of continuing
    // forever. The result should be a final error, not an infinite hang.
    expect(result.kind).toBe("final");
    // One initial attempt plus two retries.
    expect(switchCallCount).toBe(3);
  });

  it("propagates auth profile state on bounded live model switch retries (#58348)", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        invocation++;
        if (invocation <= 2) {
          return {
            result: await params.run("anthropic", "claude"),
            provider: "anthropic",
            model: "claude",
            attempts: [],
          };
        }
        // Third invocation succeeds with the switched model
        return {
          result: await params.run("openai", "gpt-5.4"),
          provider: "openai",
          model: "gpt-5.4",
          attempts: [],
        };
      },
    );
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "profile-b",
          authProfileIdSource: "user",
        });
      })
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "profile-c",
          authProfileIdSource: "auto",
        });
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "finally ok" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        };
      });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
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

    // Two switches (within the limit of 2) then success on third attempt
    expect(result.kind).toBe("success");
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(3);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
    expect(followupRun.run.authProfileId).toBe("profile-c");
    expect(followupRun.run.authProfileIdSource).toBe("auto");
  });

  it("does not roll back newer override changes after a failed fallback candidate", async () => {
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await expect(params.run("openai", "gpt-5.4")).rejects.toThrow("fallback failed");
        throw new Error("fallback failed");
      },
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      providerOverride: "anthropic",
      modelOverride: "claude",
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
    };
    const sessionStore = { main: sessionEntry };
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      sessionEntry.providerOverride = "zai";
      sessionEntry.modelOverride = "glm-5";
      sessionEntry.authProfileOverride = "zai:work";
      sessionEntry.authProfileOverrideSource = "user";
      throw new Error("fallback failed");
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
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
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    expect(sessionEntry.providerOverride).toBe("zai");
    expect(sessionEntry.modelOverride).toBe("glm-5");
    expect(sessionEntry.authProfileOverride).toBe("zai:work");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionStore.main.providerOverride).toBe("zai");
    expect(sessionStore.main.modelOverride).toBe("glm-5");
  });

  it("keeps cross-provider fallback selection turn-local", async () => {
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus";
    followupRun.run.authProfileId = "anthropic:openclaw";
    followupRun.run.authProfileIdSource = "user";

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
    };
    const sessionStore = { main: sessionEntry };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
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
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionStore.main.authProfileOverride).toBeUndefined();
  });

  it("does not persist fallback selection for legacy user overrides without modelOverrideSource", async () => {
    // Regression: older persisted sessions can have a user-selected override
    // (modelOverride set) but no modelOverrideSource field, because the field
    // was added later.  These legacy entries must still be protected from
    // fallback overwrite, matching the backward-compat treatment in
    // session-reset-service.
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "bailian";
    followupRun.run.model = "qwen3.6-plus";

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
      // Legacy entry: override is set but the source field is missing.
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      // modelOverrideSource intentionally absent
    };
    const sessionStore = { main: sessionEntry };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
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
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    // Legacy user override must survive the fallback unchanged.
    expect(sessionEntry.providerOverride).toBe("anthropic");
    expect(sessionEntry.modelOverride).toBe("claude-opus-4-6");
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
  });

  it("does not replace a recovered auto override during fallback", async () => {
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus-4-6";

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
      providerOverride: "bailian",
      modelOverride: "qwen3.6-plus",
      modelOverrideFallbackOriginProvider: "minimax",
      modelOverrideFallbackOriginModel: "MiniMax-M2.7",
      // modelOverrideSource intentionally absent
    };
    const sessionStore = { main: sessionEntry };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
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
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(sessionEntry.providerOverride).toBe("bailian");
    expect(sessionEntry.modelOverride).toBe("qwen3.6-plus");
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.modelOverrideFallbackOriginProvider).toBe("minimax");
    expect(sessionEntry.modelOverrideFallbackOriginModel).toBe("MiniMax-M2.7");
  });

  it("does not persist fallback selection when modelOverrideSource is user", async () => {
    // Regression: fallback persistence overwrote user-initiated /models
    // selections.  When the user explicitly picked a model, the fallback
    // should NOT clobber it even when the primary model fails.
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus-4-6";

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
      // User explicitly selected this model via /models
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    };
    const sessionStore = { main: sessionEntry };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
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
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    // The user's /models selection must survive the fallback.
    expect(sessionEntry.providerOverride).toBe("anthropic");
    expect(sessionEntry.modelOverride).toBe("claude-opus-4-6");
    expect(sessionEntry.modelOverrideSource).toBe("user");
  });

  it("latches assistant error stub suppression across main reply fallback candidates", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("anthropic", "claude-opus-4-7").catch(() => undefined);
      await params.run("anthropic", "claude-opus-4-6").catch(() => undefined);
      return {
        result: await params.run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (args: {
        onAssistantErrorMessagePersisted?: (message: {
          role: "assistant";
          content: string;
          stopReason: "error";
        }) => void;
      }) => {
        args.onAssistantErrorMessagePersisted?.({
          role: "assistant",
          content: "[assistant turn failed before producing content]",
          stopReason: "error",
        });
        throw new Error("upstream 500");
      },
    );
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("upstream 500"));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(3);
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "primary candidate", {
      suppressAssistantErrorPersistence: false,
    });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "first fallback candidate", {
      suppressAssistantErrorPersistence: true,
    });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 2, "second fallback candidate", {
      suppressAssistantErrorPersistence: true,
    });
  });

  it("does not suppress the first embedded assistant error after a CLI fallback failure", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "anthropic");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("anthropic", "claude-opus-4-7").catch(() => undefined);
      return {
        result: await params.run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runCliAgentMock.mockRejectedValueOnce(new Error("cli failed"));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded fallback candidate", {
      suppressAssistantErrorPersistence: false,
    });
  });

  it("latches queued user message persistence across main reply fallback candidates", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("anthropic", "claude-opus-4-7").catch(() => undefined);
      return {
        result: await params.run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (args: {
        onUserMessagePersisted?: (m: {
          role: "user";
          content: Array<{ type: "text"; text: string }>;
        }) => void;
      }) => {
        args.onUserMessagePersisted?.({
          role: "user",
          content: [{ type: "text", text: "queued" }],
        });
        throw new Error("upstream 500");
      },
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "primary candidate", {
      suppressNextUserMessagePersistence: false,
    });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "fallback candidate", {
      suppressNextUserMessagePersistence: true,
    });
  });
});
