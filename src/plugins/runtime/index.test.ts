import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import * as execModule from "../../process/exec.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { VERSION } from "../../version.js";
import {
  clearGatewaySubagentRuntime,
  createPluginRuntime,
  setGatewayNodesRuntime,
  setGatewaySubagentRuntime,
} from "./index.js";

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
    getSession: vi.fn(),
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

function createGatewaySubagentRunFixture(params?: { allowGatewaySubagentBinding?: boolean }) {
  const run = vi.fn().mockResolvedValue({ runId: "run-1" });
  const runtime = params?.allowGatewaySubagentBinding
    ? createPluginRuntime({ allowGatewaySubagentBinding: true })
    : createPluginRuntime();

  setGatewaySubagentRuntime({
    ...createGatewaySubagentRuntime(),
    run,
  });

  return { run, runtime };
}

function expectFunctionKeys(value: Record<string, unknown>, keys: readonly string[]) {
  keys.forEach((key) => {
    expect(typeof value[key]).toBe("function");
  });
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
    clearGatewaySubagentRuntime();
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
      name: "exposes runtime.system.requestHeartbeatNow",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) =>
        runtime.system.requestHeartbeatNow,
      expected: requestHeartbeatNow,
    },
    {
      name: "exposes runtime.version from the shared VERSION constant",
      readValue: (runtime: ReturnType<typeof createPluginRuntime>) => runtime.version,
      expected: VERSION,
    },
  ] as const)("$name", ({ readValue, expected }) => {
    expectRuntimeValue(readValue, expected);
  });

  it.each([
    {
      name: "exposes runtime.mediaUnderstanding helpers and keeps stt as an alias",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expectFunctionKeys(runtime.mediaUnderstanding as Record<string, unknown>, [
          "runFile",
          "describeImageFile",
          "describeImageFileWithModel",
          "describeVideoFile",
        ]);
        expect(runtime.mediaUnderstanding.transcribeAudioFile).toBe(
          runtime.stt.transcribeAudioFile,
        );
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
      name: "exposes canonical runtime.tasks task runtimes while keeping legacy TaskFlow aliases",
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
        expectFunctionKeys(runtime.tasks.flow as Record<string, unknown>, [
          "bindSession",
          "fromToolContext",
        ]);
        expect(runtime.tasks.managedFlows).toBe(runtime.tasks.flow);
        expect(runtime.taskFlow).toBe(runtime.tasks.managedFlows);
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
          "runEmbeddedAgent",
          "runEmbeddedPiAgent",
          "normalizeThinkingLevel",
          "resolveThinkingPolicy",
          "resolveAgentDir",
        ]);
        expectFunctionKeys(runtime.agent.session as Record<string, unknown>, [
          "resolveSessionFilePath",
        ]);
      },
    },
    {
      name: "exposes runtime.modelAuth with raw and runtime-ready auth helpers",
      assert: (runtime: ReturnType<typeof createPluginRuntime>) => {
        expect(runtime.modelAuth).toBeDefined();
        expectFunctionKeys(runtime.modelAuth as Record<string, unknown>, [
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
    const { getApiKeyForModel: rawGetApiKey } = await import("../../agents/model-auth.js");
    const runtime = createPluginRuntime();
    // Wrappers should NOT be the same reference as the raw functions
    expect(runtime.modelAuth.getApiKeyForModel).not.toBe(rawGetApiKey);
  });

  it("keeps subagent unavailable by default even after gateway initialization", async () => {
    const { runtime } = createGatewaySubagentRunFixture();

    expectGatewaySubagentRunFailure(runtime, { sessionKey: "s-1", message: "hello" });
  });

  it("late-binds to the gateway subagent when explicitly enabled", async () => {
    const { run, runtime } = createGatewaySubagentRunFixture({
      allowGatewaySubagentBinding: true,
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
    };
    const runtime = createPluginRuntime({ nodes });

    await expect(runtime.nodes.list({ connected: true })).resolves.toEqual({ nodes: [] });
    await expect(
      runtime.nodes.invoke({ nodeId: "node-1", command: "browser.proxy" }),
    ).resolves.toEqual({ ok: true });
    expect(nodes.list).toHaveBeenCalledWith({ connected: true });
    expect(nodes.invoke).toHaveBeenCalledWith({ nodeId: "node-1", command: "browser.proxy" });
  });

  it("late-binds to gateway nodes when explicitly enabled", async () => {
    const nodes = {
      list: vi.fn().mockResolvedValue({ nodes: [{ nodeId: "node-1" }] }),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };
    const runtime = createPluginRuntime({ allowGatewaySubagentBinding: true });
    setGatewayNodesRuntime(nodes);

    await expect(runtime.nodes.list({ connected: true })).resolves.toEqual({
      nodes: [{ nodeId: "node-1" }],
    });
    expect(nodes.list).toHaveBeenCalledWith({ connected: true });
  });
});
