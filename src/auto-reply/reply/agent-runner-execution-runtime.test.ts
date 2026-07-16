import { describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  requireRecord,
  requireMockCall,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: runtime selection", () => {
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.messageProvider = "stale-provider";

    await runAgentTurnWithFallback({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
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

    const result = await runAgentTurnWithFallback({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";

    const result = await runAgentTurnWithFallback({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
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

    const result = await runAgentTurnWithFallback({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    followupRun.run.provider = "openai";
    followupRun.run.model = "gpt-5.4";
    followupRun.run.config = {
      agents: {
        defaults: {
          cliBackends: {
            codex: { command: "codex" },
          },
        },
      },
    };

    const result = await runAgentTurnWithFallback({
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
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

    const result = await runAgentTurnWithFallback({
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
