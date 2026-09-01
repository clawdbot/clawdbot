// Plugin runtime index tests cover runtime entrypoint exports and registry setup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { requestHeartbeat, setHeartbeatWakeHandler } from "../../infra/heartbeat-wake.js";
import * as execModule from "../../process/exec.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { VERSION } from "../../version.js";

const runtimeModelAuthMocks = vi.hoisted(() => ({
  getApiKeyForModel: vi.fn(),
  getRuntimeAuthForModelCore: vi.fn(),
  resolveProviderRuntimeApiKey: vi.fn(),
}));
const heartbeatRunnerMocks = vi.hoisted(() => ({ loads: 0, runHeartbeatOnce: vi.fn() }));
vi.mock("../../infra/heartbeat-runner.js", () => {
  heartbeatRunnerMocks.loads++;
  return { runHeartbeatOnce: heartbeatRunnerMocks.runHeartbeatOnce };
});

const sandboxContextMocks = vi.hoisted(() => ({
  resolveSandboxContext: vi.fn(),
}));

vi.mock("./runtime-model-auth.runtime.js", () => ({
  getApiKeyForModel: runtimeModelAuthMocks.getApiKeyForModel,
  getRuntimeAuthForModelCore: runtimeModelAuthMocks.getRuntimeAuthForModelCore,
  resolveProviderRuntimeApiKey: runtimeModelAuthMocks.resolveProviderRuntimeApiKey,
}));
vi.mock("../../agents/sandbox/context.js", () => sandboxContextMocks);

import { createPluginRuntime } from "./index.js";

function createCommandResult() {
  return {
    pid: 12345,
    stdout: "hello\n",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    noOutputTimedOut: false,
    termination: "exit" as const,
  };
}

function createGatewaySubagentRuntime() {
  return {
    run: vi.fn(),
    waitForRun: vi.fn(),
    getSessionMessages: vi.fn(),
    deleteSession: vi.fn(),
  };
}

function expectRuntimeShape(
  assertRuntime: (runtime: ReturnType<typeof createPluginRuntime>) => void,
) {
  const runtime = createPluginRuntime();
  assertRuntime(runtime);
}

function expectGatewaySubagentRunFailure(
  runtime: ReturnType<typeof createPluginRuntime>,
  params: { sessionKey: string; message: string },
) {
  expect(() => runtime.subagent.run(params)).toThrow(
    "Plugin runtime subagent methods are only available during a gateway request.",
  );
}

function expectRuntimeValue<T>(
  readValue: (runtime: ReturnType<typeof createPluginRuntime>) => T,
  expected: T,
) {
  expect(readValue(createPluginRuntime())).toBe(expected);
}

function expectRuntimeSubagentRun(
  runtime: ReturnType<typeof createPluginRuntime>,
  params: { sessionKey: string; message: string },
) {
  return runtime.subagent.run(params);
}

function expectFunctionKeys(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    expect(typeof value[key]).toBe("function");
  }
}

function expectRunCommandOutcome(params: {
  runtime: ReturnType<typeof createPluginRuntime>;
  expected: "resolve" | "reject";
  commandResult: ReturnType<typeof createCommandResult>;
}) {
  const command = params.runtime.system.runCommandWithTimeout(["echo", "hello"], {
    timeoutMs: 1000,
  });
  if (params.expected === "resolve") {
    return expect(command).resolves.toEqual(params.commandResult);
  }
  return expect(command).rejects.toThrow("boom");
}

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runtimeModelAuthMocks.getApiKeyForModel.mockReset();
    runtimeModelAuthMocks.getRuntimeAuthForModelCore.mockReset();
    runtimeModelAuthMocks.resolveProviderRuntimeApiKey.mockReset();
    sandboxContextMocks.resolveSandboxContext.mockReset();
    resetConfigRuntimeState();
  });

  it.each([
    {
      name: "exposes runtime.system.runCommandWithTimeout by default",
      mockKind: "resolve" as const,
      expected: "resolve" as const,
    },
    {
      name: "forwards runtime.system.runCommandWithTimeout errors",
      mockKind: "reject" as const,
      expected: "reject" as const,
    },
  ] as const)("$name", async ({ mockKind, expected }) => {
    const commandResult = createCommandResult();
    const runCommandWithTimeoutMock = vi.spyOn(execModule, "runCommandWithTimeout");
    if (mockKind === "resolve") {
      runCommandWithTimeoutMock.mockResolvedValue(commandResult);
    } else {
      runCommandWithTimeoutMock.mockRejectedValue(new Error("boom"));
    }

    const runtime = createPluginRuntime();
    await expectRunCommandOutcome({ runtime, expected, commandResult });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("defers heartbeat execution and forwards only plugin-safe options", async () => {
    const system = createPluginRuntime().system;
    expect(heartbeatRunnerMocks.loads).toBe(0);
    const result = { status: "skipped", reason: "disabled" };
    heartbeatRunnerMocks.runHeartbeatOnce.mockResolvedValueOnce(result);
    await expect(
      system.runHeartbeatOnce({
        reason: "plugin-event",
        agentId: "main",
        sessionKey: "session",
        heartbeat: { target: "none", every: "1ms" },
        cfg: {},
        deps: {},
      } as Parameters<typeof system.runHeartbeatOnce>[0]),
    ).resolves.toBe(result);
    expect(heartbeatRunnerMocks.loads).toBe(1);
    expect(heartbeatRunnerMocks.runHeartbeatOnce).toHaveBeenCalledWith({
      reason: "plugin-event",
      agentId: "main",
      sessionKey: "session",
      heartbeat: { target: "none" },
    });
    const failure = new Error("heartbeat failed");
    heartbeatRunnerMocks.runHeartbeatOnce.mockRejectedValueOnce(failure);
    await expect(system.runHeartbeatOnce()).rejects.toBe(failure);
    expect(heartbeatRunnerMocks.runHeartbeatOnce).toHaveBeenLastCalledWith({
      reason: undefined,
      agentId: undefined,
      sessionKey: undefined,
      heartbeat: undefined,
    });
    heartbeatRunnerMocks.runHeartbeatOnce.mockReset();
  });

  it.each([
    {
      name: "exposes runtime.events.onAgentEvent",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) => runtime.events.onAgentEvent,
      expected: onAgentEvent,
    },
    {
      name: "exposes runtime.events.onSessionTranscriptUpdate",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) =>
        runtime.events.onSessionTranscriptUpdate,
      expected: onSessionTranscriptUpdate,
    },
    {
      name: "exposes runtime.system.requestHeartbeat",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) =>
        runtime.system.requestHeartbeat,
      expected: requestHeartbeat,
    },
    {
      name: "exposes deprecated runtime.system.requestHeartbeatNow",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) =>
        typeof runtime.system.requestHeartbeatNow,
      expected: "function",
    },
    {
      name: "exposes runtime.version from the shared VERSION constant",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) => runtime.version,
      expected: VERSION,
    },
  ] as const)("$name", ({ readValue, expected }) => {
    expectRuntimeValue(readValue, expected);
  });

  it("exposes reset freshness resolver on the host channel runtime", () => {
    const sessionRuntime = createPluginRuntime().channel.session as Record<string, unknown>;
    expect(typeof sessionRuntime.resolveEntryResetFreshness).toBe("function");
  });

  it("maps deprecated runtime.system.requestHeartbeatNow to an immediate compatibility wake", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async (_request: Parameters<typeof requestHeartbeat>[0]) => ({
      status: "skipped" as const,
      reason: "disabled",
    }));
    const dispose = setHeartbeatWakeHandler(handler);
    try {
      createPluginRuntime().system.requestHeartbeatNow({
        reason: "legacy-plugin",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      const request = handler.mock.calls[0]?.[0] as
        | { source?: string; intent?: string; reason?: string }
        | undefined;
      expect(request?.source).toBe("other");
      expect(request?.intent).toBe("immediate");
      expect(request?.reason).toBe("legacy-plugin");
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it("resolves thinking policy with configured model compat from runtime config", () => {
    setRuntimeConfigSnapshot({
      models: {
        providers: {
          gmn: {
            baseUrl: "https://gmn.example.com/v1",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4 via GMN",
                reasoning: true,
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    const runtime = createPluginRuntime();
    const policy = runtime.agent.resolveThinkingPolicy({
      provider: "gmn",
      model: "gpt-5.4",
    });

    expect(policy.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("includes persisted session exec overrides in sandbox authority", () => {
    const runtime = createPluginRuntime();
    const getSessionEntry = vi
      .spyOn(runtime.agent.session, "getSessionEntry")
      .mockReturnValue({ sessionId: "session", updatedAt: 1, execHost: "gateway" });
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw" } },
        list: [{ id: "main", default: true }],
      },
      tools: { elevated: { enabled: false } },
    };

    const result = runtime.sandbox.resolveWorkspaceAuthority({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });

    expect(getSessionEntry).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
    });
    expect(result.confinementError).toContain("outside the sandbox");
  });

  it("prepares the live sandbox before returning workspace authority", async () => {
    const runtime = createPluginRuntime();
    vi.spyOn(runtime.agent.session, "getSessionEntry").mockReturnValue(undefined);
    sandboxContextMocks.resolveSandboxContext.mockResolvedValue({ backendId: "docker" });
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw" } },
        list: [{ id: "main", default: true, workspace: "/workspace" }],
      },
      tools: {
        elevated: { enabled: false },
        sandbox: { tools: { allow: ["read"] } },
      },
    };

    await expect(
      runtime.sandbox.prepareWorkspaceAuthority({
        config,
        agentId: "main",
        sessionKey: "agent:main:subagent:workboard-card",
        workspaceDir: "/workspace",
      }),
    ).resolves.toEqual({ sandboxed: true, workspaceAccess: "rw" });
    expect(sandboxContextMocks.resolveSandboxContext).toHaveBeenCalledWith({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      workspaceDir: "/workspace",
      requireCurrentConfig: true,
    });
  });

  it.each([
    {
      name: "exposes runtime.mediaUnderstanding helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.mediaUnderstanding as Record<string, unknown>, [
          "runFile",
          "describeImageFile",
          "describeImageFileWithModel",
          "extractStructuredWithModel",
          "describeVideoFile",
        ]);
        expect(runtime.mediaUnderstanding.transcribeAudioFile).toBeTypeOf("function");
      },
    },
    {
      name: "exposes runtime.imageGeneration helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.imageGeneration as Record<string, unknown>, [
          "generate",
          "listProviders",
        ]);
      },
    },
    {
      name: "exposes runtime.webSearch helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.webSearch as Record<string, unknown>, [
          "listProviders",
          "search",
        ]);
      },
    },
    {
      name: "exposes canonical runtime.tasks task runtimes",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.tasks.runs as Record<string, unknown>, [
          "bindSession",
          "fromToolContext",
        ]);
        expectFunctionKeys(runtime.tasks.flows as Record<string, unknown>, [
          "bindSession",
          "fromToolContext",
        ]);
        expectFunctionKeys(runtime.tasks.managedFlows as Record<string, unknown>, [
          "bindSession",
          "fromToolContext",
        ]);
      },
    },
    {
      name: "exposes runtime.agent host helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(runtime.agent.defaults).toEqual({
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
        });
        expectFunctionKeys(runtime.agent as Record<string, unknown>, [
          "runCommandFromIngress",
          "runEmbeddedAgent",
          "normalizeThinkingLevel",
          "resolveThinkingPolicy",
          "resolveAgentDir",
        ]);
        expectFunctionKeys(runtime.agent.session as Record<string, unknown>, [
          "createSessionEntry",
          "getSessionEntry",
          "listSessionEntries",
          "patchSessionEntry",
          "upsertSessionEntry",
          "runWithWorkAdmission",
          "updateSessionStoreEntry",
        ]);
      },
    },
    {
      name: "exposes runtime.llm completion and provider-service acquisition",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.llm as Record<string, unknown>, [
          "complete",
          "acquireLocalService",
        ]);
      },
    },
    {
      name: "exposes runtime.sandbox workspace-authority resolution",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.sandbox as Record<string, unknown>, [
          "resolveWorkspaceAuthority",
          "prepareWorkspaceAuthority",
        ]);
      },
    },
    {
      name: "exposes runtime.worktrees checkout inspection and lifecycle helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.worktrees as Record<string, unknown>, [
          "resolveCheckoutRoot",
          "hasSelfContainedCheckoutMetadata",
          "create",
          "release",
          "removeIfLossless",
        ]);
      },
    },
    {
      name: "exposes runtime.modelAuth with raw and runtime-ready auth helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.modelAuth, [
          "getApiKeyForModel",
          "getRuntimeAuthForModel",
          "resolveApiKeyForProvider",
        ]);
      },
    },
  ] as const)("$name", ({ assert }) => {
    expectRuntimeShape(assert);
  });

  it("modelAuth wrappers strip agentDir and store to prevent credential steering", async () => {
    // The wrappers should not forward agentDir or store from plugin callers.
    // We verify this by checking the wrapper functions exist and are not the
    // raw implementations (they are wrapped, not direct references).
    const { getApiKeyForModelCore: rawGetApiKey } = await import("../../agents/model-auth.js");
    const runtime = createPluginRuntime();
    // Wrappers should NOT be the same reference as the raw functions
    expect(runtime.modelAuth.getApiKeyForModel).not.toBe(rawGetApiKey);
  });

  it("modelAuth wrappers preserve workspace scope while stripping credential steering", async () => {
    const runtime = createPluginRuntime();
    const model = {
      id: "workspace-cloud/model",
      provider: "workspace-cloud",
      api: "openai-responses",
      baseUrl: "https://workspace-cloud.example/v1",
    };
    const cfg = { plugins: { allow: ["workspace-cloud"] } } as OpenClawConfig;
    runtimeModelAuthMocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "model-key",
      source: "workspace cloud credentials",
      mode: "api-key",
    });
    runtimeModelAuthMocks.resolveProviderRuntimeApiKey.mockResolvedValue({
      apiKey: "provider-key",
      source: "workspace cloud credentials",
      mode: "api-key",
    });

    const modelAuth = await runtime.modelAuth.getApiKeyForModel({
      model: model as never,
      cfg,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      store: { version: 1, profiles: {} },
    } as never);
    expect(modelAuth.apiKey).toBe("model-key");

    const providerAuth = await runtime.modelAuth.resolveApiKeyForProvider({
      provider: "workspace-cloud",
      cfg,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      store: { version: 1, profiles: {} },
    } as never);
    expect(providerAuth.apiKey).toBe("provider-key");

    expect(runtimeModelAuthMocks.getApiKeyForModel).toHaveBeenCalledWith({
      model,
      cfg,
      workspaceDir: "/tmp/workspace",
    });
    expect(runtimeModelAuthMocks.resolveProviderRuntimeApiKey).toHaveBeenCalledWith({
      provider: "workspace-cloud",
      cfg,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("keeps subagent unavailable by default", () => {
    const runtime = createPluginRuntime();
    expectGatewaySubagentRunFailure(runtime, { sessionKey: "s-1", message: "hello" });
  });

  it("exposes a node duplex capability even when Gateway access is unavailable", () => {
    const nodes = createPluginRuntime().nodes;
    expect(nodes).toHaveProperty("openDuplex", expect.any(Function));
    expect(() => nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" })).toThrow(
      "only available inside the Gateway",
    );
  });

  it("uses an explicit subagent runtime", async () => {
    const run = vi.fn().mockResolvedValue({ runId: "run-1" });
    const runtime = createPluginRuntime({
      subagent: { ...createGatewaySubagentRuntime(), run },
    });

    await expect(
      expectRuntimeSubagentRun(runtime, { sessionKey: "s-2", message: "hello" }),
    ).resolves.toEqual({
      runId: "run-1",
    });
    expect(run).toHaveBeenCalledWith({ sessionKey: "s-2", message: "hello" });
  });

  it("uses explicit nodes runtime when provided", async () => {
    const nodes = {
      list: vi.fn().mockResolvedValue({ nodes: [] }),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
      openDuplex: vi.fn().mockResolvedValue({ closed: Promise.resolve({ ok: true }) }),
    };
    const runtime = createPluginRuntime({ nodes });

    await expect(runtime.nodes.list({ connected: true })).resolves.toEqual({ nodes: [] });
    await expect(
      runtime.nodes.invoke({ nodeId: "node-1", command: "browser.proxy" }),
    ).resolves.toEqual({ ok: true });
    expect(nodes.list).toHaveBeenCalledWith({ connected: true });
    expect(nodes.invoke).toHaveBeenCalledWith({ nodeId: "node-1", command: "browser.proxy" });
    await expect(
      runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" }),
    ).resolves.toMatchObject({ closed: expect.any(Promise) });
    expect(nodes.openDuplex).toHaveBeenCalledWith({ nodeId: "node-1", command: "image.bridge" });
  });
});
