import { describe, expect, it, vi } from "vitest";
import { createAgentExecutionAttribution } from "../../agents/agent-execution-attribution.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  GENERIC_RUN_FAILURE_TEXT,
  requireRecord,
  requireMockCall,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: runtime selection", () => {
  it.each(["group", "channel"] as const)(
    "forwards authoritative %s type through CLI fallback for opaque session keys",
    async (chatType) => {
      state.isCliProviderMock.mockReturnValue(true);
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run("codex-cli", "gpt-5.4"),
          provider: "codex-cli",
          model: "gpt-5.4",
          attempts: [],
        }),
      );
      state.runCliAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "final" }],
        meta: {},
      });

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const followupRun = createFollowupRun();
      followupRun.run.provider = "codex-cli";
      followupRun.run.model = "gpt-5.4";
      followupRun.run.sessionKey = "agent:main:opaque:binding";
      followupRun.run.chatType = chatType;

      await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: {
            Provider: "discord",
            MessageSid: "msg",
          } as unknown as TemplateContext,
        }),
        sessionKey: "agent:main:opaque:binding",
      });

      expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
        sessionKey: "agent:main:opaque:binding",
        chatType,
      });
    },
  );

  it("prefers normalized current shared context over stale queued direct metadata", async () => {
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.sessionKey = "agent:main:opaque:binding";
    followupRun.run.chatType = "direct";

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          ChatType: "Channel",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      sessionKey: "agent:main:opaque:binding",
    });

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      sessionKey: "agent:main:opaque:binding",
      chatType: "channel",
    });
  });

  it("resolves CLI messageProvider from the live session surface when no origin channel is set", async () => {
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.messageProvider = "stale-provider";

    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
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

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      messageChannel: undefined,
      messageProvider: "discord",
    });
  });

  it("rebases direct CLI attribution after lifecycle rotation during preflight", async () => {
    const agentRunRegistry = await import("../../infra/agent-run-registry.js");
    const runId = "cli-lifecycle-rebind-refreshes-registration";
    const staleRegisteredAt = 1;
    agentRunRegistry.claimAgentRunContext(runId, {
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      registeredAt: staleRegisteredAt,
    });
    state.isCliProviderMock.mockReturnValue(true);
    let rotatedGeneration = "";
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      rotatedGeneration = rotateAgentEventLifecycleGeneration();
      return {
        result: await params.run("codex-cli", "gpt-5.4"),
        provider: "codex-cli",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    let reboundContext: ReturnType<typeof agentRunRegistry.getAgentRunContext>;
    state.runCliAgentMock.mockImplementationOnce(async () => {
      reboundContext = agentRunRegistry.getAgentRunContext(runId);
      return {
        payloads: [{ text: "final" }],
        meta: {},
      };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";

    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        opts: { runId },
      }),
    );

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      lifecycleGeneration: rotatedGeneration,
      attribution: expect.objectContaining({
        lifecycleGeneration: rotatedGeneration,
      }),
    });
    expect(reboundContext).toEqual(
      expect.objectContaining({
        lifecycleGeneration: rotatedGeneration,
        registeredAt: expect.any(Number),
      }),
    );
    expect(reboundContext?.registeredAt).not.toBe(staleRegisteredAt);
    agentRunRegistry.resetAgentRunRegistryForTest();
  });

  it("preserves absent attribution identity while rebasing direct CLI execution", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    let rotatedGeneration = "";
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      rotatedGeneration = rotateAgentEventLifecycleGeneration();
      return {
        result: await params.run("codex-cli", "gpt-5.4"),
        provider: "codex-cli",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const runId = "cli-sparse-attribution";
    const attribution = createAgentExecutionAttribution({
      runId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun, opts: { runId } }),
      attribution,
    });

    const cliParams = requireRecord(
      requireMockCall(state.runCliAgentMock, 0, "CLI run")[0],
      "CLI run params",
    );
    const cliAttribution = requireRecord(cliParams.attribution, "CLI run attribution");
    expect(cliAttribution).toEqual({
      ...attribution,
      lifecycleGeneration: rotatedGeneration,
    });
    expect(cliAttribution.executionId).toBe(attribution.executionId);
    expect(cliAttribution.contextId).toBe(attribution.contextId);
    expect(cliAttribution).not.toHaveProperty("sessionKey");
    expect(cliAttribution).not.toHaveProperty("sessionId");
    expect(cliAttribution).not.toHaveProperty("agentId");
  });

  it("rejects a CLI run id already bound to different execution attribution", async () => {
    const agentRunRegistry = await import("../../infra/agent-run-registry.js");
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const runId = "cli-attribution-collision";
    const existingAttribution = createAgentExecutionAttribution({
      runId,
      lifecycleGeneration,
    });
    agentRunRegistry.claimAgentRunContext(runId, {
      attribution: existingAttribution,
      lifecycleGeneration,
    });
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    await expect(
      executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun, opts: { runId } }),
        attribution: createAgentExecutionAttribution({
          runId,
          lifecycleGeneration,
        }),
      }),
    ).resolves.toEqual({
      kind: "final",
      payload: {
        isError: true,
        text: GENERIC_RUN_FAILURE_TEXT,
      },
    });

    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expect(agentRunRegistry.getAgentRunContext(runId)?.attribution).toBe(existingAttribution);
    agentRunRegistry.resetAgentRunRegistryForTest();
  });

  it("rejects a fresh auto-reply run id collision before recording execution identity", async () => {
    const agentRunRegistry = await import("../../infra/agent-run-registry.js");
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const runId = "fresh-auto-reply-attribution-collision";
    const existingAttribution = createAgentExecutionAttribution({
      runId,
      lifecycleGeneration,
    });
    agentRunRegistry.claimAgentRunContext(runId, {
      attribution: existingAttribution,
      lifecycleGeneration,
    });
    const sink = vi.fn(() => true);
    const restoreSink = configureExecutionIdentityAdmissionSink(sink);
    const followupRun = createFollowupRun();
    followupRun.run.config = {
      logging: { audit: { enabled: true, executionIdentity: true } },
    };

    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      await expect(
        executeAgentTurn(
          createMinimalRunAgentTurnParams({
            followupRun,
            opts: { runId },
          }),
        ),
      ).resolves.toEqual({
        kind: "final",
        payload: {
          isError: true,
          text: GENERIC_RUN_FAILURE_TEXT,
        },
      });

      expect(sink).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(agentRunRegistry.getAgentRunContext(runId)?.attribution).toBe(existingAttribution);
    } finally {
      restoreSink();
      agentRunRegistry.resetAgentRunRegistryForTest();
    }
  });

  it("rejects queued heartbeat CLI fallback after placement crosses a lifecycle rotation", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("codex-cli", "gpt-5.4"),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "must not run" }],
      meta: {},
    });
    const uninstallPlacement = installSessionPlacementAdmissionProvider({
      executeLocalTurn: async (_claim, runLocal) => {
        rotateAgentEventLifecycleGeneration();
        return await runLocal();
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });

    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const followupRun = createFollowupRun();
      followupRun.run.provider = "codex-cli";
      followupRun.run.model = "gpt-5.4";
      const turn = createMinimalRunAgentTurnParams({ followupRun });
      turn.isHeartbeat = true;

      await expect(executeAgentTurn(turn)).resolves.toEqual({
        kind: "final",
        payload: {
          isError: true,
          text: "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.",
        },
      });
      expect(state.runCliAgentMock).not.toHaveBeenCalled();
    } finally {
      uninstallPlacement();
    }
  });

  it("preserves one admission attribution across model fallback candidates", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("openai", "gpt-5.4");
      const result = await params.run("anthropic", "claude-opus-4-7");
      return {
        result,
        provider: "anthropic",
        model: "claude-opus-4-7",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock
      .mockResolvedValueOnce({ payloads: [{ text: "retry" }], meta: {} })
      .mockResolvedValueOnce({ payloads: [{ text: "final" }], meta: {} });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(
      createMinimalRunAgentTurnParams({ opts: { runId: "fallback-attribution" } }),
    );

    const firstAttribution = state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.attribution;
    expect(firstAttribution).toMatchObject({
      runId: "fallback-attribution",
      sessionKey: "main",
      sessionId: "session",
    });
    expect(Object.isFrozen(firstAttribution)).toBe(true);
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.attribution).toBe(firstAttribution);
  });

  it("does not pass CLI runtime overrides as embedded harness ids for fallback providers", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend, config }) =>
        backend === "claude-cli" && config
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
    });
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4"),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus-4-7";
    followupRun.run.config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
    };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "session",
          updatedAt: Date.now(),
          agentRuntimeOverride: "claude-cli",
        }) as SessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(
      requireRecord(
        requireMockCall(state.runEmbeddedAgentMock, 0, "embedded run params")[0],
        "embedded run params",
      ),
    ).not.toHaveProperty("agentHarnessId", "claude-cli");
  });

  it("passes OpenAI session runtime overrides as embedded harness ids", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4"),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "openai" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "session",
          updatedAt: Date.now(),
          agentRuntimeOverride: "codex",
        }) as SessionEntry,
    });

    expect(result.kind).toBe("success");
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: "codex",
    });
  });

  it("keeps catalog-adopted Codex sessions on Codex during heartbeat model overrides", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude-opus-4-6"),
      provider: "anthropic",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "heartbeat" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-opus-4-6";
    followupRun.run.config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      isHeartbeat: true,
      getActiveSessionEntry: () =>
        ({
          sessionId: "catalog-adopted-session",
          updatedAt: Date.now(),
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: {
              supervision: {
                sourceThreadId: "019f-codex-thread",
                modelLocked: true,
              },
            },
          },
        }) as SessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: "anthropic",
      model: "claude-opus-4-6",
      trigger: "heartbeat",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
    });
  });

  it("keeps a locked Codex harness embedded when cliBackends.codex is configured", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "codex");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4"),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "continued" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.config = {};

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "catalog-adopted-session",
          updatedAt: Date.now(),
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        }) as SessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
    });
  });

  it("honors agent session runtime overrides before CLI runtime aliases", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("openai", "gpt-5.4"),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "agent" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
    };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "session",
          updatedAt: Date.now(),
          agentRuntimeOverride: "codex",
        }) as SessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: "codex",
    });
  });
});
