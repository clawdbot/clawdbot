/**
 * Resolve-exec-env hook tests.
 * Verifies plugin-provided env values are filtered and forwarded to the chosen
 * exec host without leaking unsafe overrides.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import type { ExtensionContext } from "./sessions/index.js";

declare module "../plugins/hook-types.js" {
  interface PluginHookChannelSenderContext {
    unionId?: string;
  }
}

const CHANNEL_CONTEXT_ENV_KEY = "OPENCLAW_CHANNEL_CONTEXT";
const OPENCLAW_CLI_ENV_VALUE = "1";
type CapturedNodeHostParams = Pick<
  ExecuteNodeHostCommandParams,
  "env" | "requestedEnv" | "workdir"
>;

const mocks = vi.hoisted(() => ({
  hookRunner: undefined as
    | {
        hasHooks: ReturnType<typeof vi.fn>;
        runResolveExecEnv?: ReturnType<typeof vi.fn>;
        runBeforeToolCall?: ReturnType<typeof vi.fn>;
      }
    | undefined,
  beforeToolCallParams: [] as Array<Record<string, unknown>>,
  gatewayParams: [] as Array<{
    env: Record<string, string>;
    requestedEnv?: Record<string, string>;
  }>,
  nodeHostParams: [] as CapturedNodeHostParams[],
  spawnInputs: [] as Array<{
    env?: Record<string, string>;
  }>,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
  getGlobalHookRunnerRegistry: () => null,
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: vi.fn(() => []),
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(
    async (params: { env: Record<string, string>; requestedEnv?: Record<string, string> }) => {
      mocks.gatewayParams.push({
        env: { ...params.env },
        requestedEnv: params.requestedEnv ? { ...params.requestedEnv } : undefined,
      });
      return {};
    },
  ),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(
    async (params: Pick<ExecuteNodeHostCommandParams, "env" | "requestedEnv" | "workdir">) => {
      mocks.nodeHostParams.push({
        env: { ...params.env },
        requestedEnv: params.requestedEnv ? { ...params.requestedEnv } : undefined,
        workdir: params.workdir,
      });
      return {
        content: [{ type: "text", text: "node ok" }],
        details: {
          status: "completed",
          exitCode: 0,
          durationMs: 0,
          aggregated: "node ok",
        },
      };
    },
  ),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: { env?: Record<string, string>; onStdout?: (chunk: string) => void }) => {
      mocks.spawnInputs.push({ env: input.env ? { ...input.env } : undefined });
      input.onStdout?.("ok\n");
      return {
        runId: "mock-run",
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: async () => ({
          reason: "exit" as const,
          exitCode: 0,
          exitSignal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        }),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let toToolDefinitions: typeof import("./agent-tool-definition-adapter.js").toToolDefinitions;
let createOpenClawCodingTools: typeof import("./agent-tools.js").createOpenClawCodingTools;
const testExtensionContext = {} as ExtensionContext;

function installResolveExecEnvHook(result: Record<string, string>) {
  mocks.hookRunner = {
    hasHooks: vi.fn((hookName: string) => hookName === "resolve_exec_env"),
    runResolveExecEnv: vi.fn(async () => result),
  };
}

describe("exec resolve_exec_env hook wiring", () => {
  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
    ({ toToolDefinitions } = await import("./agent-tool-definition-adapter.js"));
    ({ createOpenClawCodingTools } = await import("./agent-tools.js"));
  });

  beforeEach(() => {
    mocks.hookRunner = undefined;
    mocks.beforeToolCallParams.length = 0;
    mocks.gatewayParams.length = 0;
    mocks.nodeHostParams.length = 0;
    mocks.spawnInputs.length = 0;
  });

  it("adds only channel identity env to gateway exec subprocesses", async () => {
    const tool = createExecTool({
      host: "auto",
      security: "full",
      ask: "off",
      channelContext: {
        sender: { id: "ou_1", unionId: "on_1" },
        chat: { id: "oc_1" },
      },
    });

    await tool.execute("call-channel-env", {
      command: "echo ok",
      yieldMs: 120_000,
    });

    expect(JSON.parse(mocks.gatewayParams[0]?.env[CHANNEL_CONTEXT_ENV_KEY] ?? "{}")).toEqual({
      chat: { id: "oc_1" },
      sender: { id: "ou_1" },
    });
    expect(mocks.spawnInputs[0]?.env?.[CHANNEL_CONTEXT_ENV_KEY]).toBe(
      mocks.gatewayParams[0]?.env[CHANNEL_CONTEXT_ENV_KEY],
    );
  });

  it("merges filtered plugin env into gateway execution and approval-visible requested env", async () => {
    installResolveExecEnvHook({
      EXISTING: "plugin",
      PLUGIN_SAFE: "yes",
      PATH: "/tmp/plugin-bin",
      NODE_OPTIONS: "--require /tmp/hook.js",
      OPENCLAW_CLI: "0",
      "bad-key": "bad",
    });

    const tool = createExecTool({
      host: "auto",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
      messageProvider: "telegram",
      currentChannelId: "chat-1",
      channelContext: {
        sender: { id: "ou_1", unionId: "on_1" },
        chat: { id: "oc_1" },
      },
    });
    await tool.execute("call-1", {
      command: "echo ok",
      env: { EXISTING: "request" },
      yieldMs: 120_000,
    });

    expect(mocks.hookRunner?.runResolveExecEnv).toHaveBeenCalledWith(
      {
        sessionKey: "agent:main:telegram:chat-1",
        toolName: "exec",
        host: "gateway",
      },
      {
        agentId: "main",
        sessionKey: "agent:main:telegram:chat-1",
        messageProvider: "telegram",
        channelId: "chat-1",
        channelContext: {
          sender: { id: "ou_1", unionId: "on_1" },
          chat: { id: "oc_1" },
        },
      },
    );
    expect(mocks.gatewayParams[0]?.requestedEnv).toMatchObject({
      EXISTING: "plugin",
      PLUGIN_SAFE: "yes",
    });
    expect(
      JSON.parse(mocks.gatewayParams[0]?.requestedEnv?.[CHANNEL_CONTEXT_ENV_KEY] ?? "{}"),
    ).toEqual({
      chat: { id: "oc_1" },
      sender: { id: "ou_1" },
    });
    expect(mocks.gatewayParams[0]?.env).toMatchObject({
      EXISTING: "plugin",
      PLUGIN_SAFE: "yes",
    });
    expect(mocks.gatewayParams[0]?.env).not.toHaveProperty("NODE_OPTIONS");
    expect(mocks.gatewayParams[0]?.env.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
    expect(mocks.gatewayParams[0]?.env.PATH).not.toBe("/tmp/plugin-bin");
    expect(mocks.spawnInputs[0]?.env).toMatchObject({
      EXISTING: "plugin",
      PLUGIN_SAFE: "yes",
    });
  });

  it("forwards filtered plugin env to node host requests", async () => {
    installResolveExecEnvHook({
      NODE_HOST_SAFE: "yes",
      LD_PRELOAD: "/tmp/preload.dylib",
    });

    const tool = createExecTool({
      host: "node",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:main",
      channelContext: {
        sender: { id: "ou_node" },
        chat: { id: "oc_node" },
      },
    });
    await tool.execute("call-node", {
      command: "echo ok",
      env: { REQUEST_SAFE: "request" },
    });

    expect(mocks.nodeHostParams[0]?.requestedEnv).toMatchObject({
      NODE_HOST_SAFE: "yes",
      REQUEST_SAFE: "request",
    });
    expect(mocks.nodeHostParams[0]?.env).toMatchObject({
      NODE_HOST_SAFE: "yes",
      REQUEST_SAFE: "request",
    });
    expect(
      JSON.parse(mocks.nodeHostParams[0]?.requestedEnv?.[CHANNEL_CONTEXT_ENV_KEY] ?? "{}"),
    ).toEqual({
      chat: { id: "oc_node" },
      sender: { id: "ou_node" },
    });
    expect(JSON.parse(mocks.nodeHostParams[0]?.env?.[CHANNEL_CONTEXT_ENV_KEY] ?? "{}")).toEqual({
      chat: { id: "oc_node" },
      sender: { id: "ou_node" },
    });
    expect(mocks.nodeHostParams[0]?.env).not.toHaveProperty("LD_PRELOAD");
  });

  it("does not forward configured gateway cwd defaults to node host requests", async () => {
    const tool = createExecTool({
      cwd: "/gateway/default/that/node/cannot/use",
      host: "node",
      security: "full",
      ask: "off",
    });

    await tool.execute("call-node-default-cwd", {
      command: "echo ok",
    });

    expect(mocks.nodeHostParams[0]?.workdir).toBeUndefined();
  });

  it("fails blank explicit node host workdirs before node invocation", async () => {
    const tool = createExecTool({
      host: "node",
      security: "full",
      ask: "off",
    });

    const result = await tool.execute("call-node-blank-cwd", {
      command: "echo ok",
      workdir: "   ",
    });
    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(text).toContain('workdir "   " is unavailable or not a directory');
    expect(text).toContain("command was not executed");
    expect(mocks.nodeHostParams).toHaveLength(0);
  });

  it("prevalidates node workdirs before resolving exec env when a backend sandbox exists", async () => {
    installResolveExecEnvHook({ PLUGIN_SAFE: "yes" });
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createExecTool({
      host: "node",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });

    const result = await tool.execute("call-node-invalid-cwd-with-backend-sandbox", {
      command: "echo ok",
      workdir: "   ",
    });

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(mocks.hookRunner?.runResolveExecEnv).not.toHaveBeenCalled();
    expect(validateWorkdir).not.toHaveBeenCalled();
    expect(mocks.nodeHostParams).toHaveLength(0);
  });

  it("fails invalid workdirs before resolving exec env", async () => {
    installResolveExecEnvHook({ PLUGIN_SAFE: "yes" });
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
    });

    const result = await tool.execute("call-invalid-cwd-before-env", {
      command: "echo ok",
      workdir: "   ",
    });

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(mocks.hookRunner?.runResolveExecEnv).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("prevalidates gateway workdirs before resolving exec env when a backend sandbox exists", async () => {
    installResolveExecEnvHook({ PLUGIN_SAFE: "yes" });
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });

    const result = await tool.execute("call-gateway-invalid-cwd-with-backend-sandbox", {
      command: "echo ok",
      workdir: "   ",
    });

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(mocks.hookRunner?.runResolveExecEnv).not.toHaveBeenCalled();
    expect(validateWorkdir).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("lets before_tool_call see invalid wrapped workdirs before failing unchanged params", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async () => ({ PLUGIN_SAFE: "yes" })),
      runBeforeToolCall: vi.fn(async () => undefined),
    };
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
    });

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-invalid-wrapped-cwd-before-hooks",
      {
        command: "echo ok",
        workdir: "   ",
      },
      undefined,
      undefined,
      testExtensionContext,
    );
    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(text).toContain('workdir "   " is unavailable or not a directory');
    expect(mocks.hookRunner.runBeforeToolCall!).toHaveBeenCalledTimes(1);
    expect(mocks.hookRunner.runResolveExecEnv!).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("does not validate backend sandbox workdirs before before_tool_call veto", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    mocks.hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_tool_call"),
      runBeforeToolCall: vi.fn(async () => ({
        block: true,
        blockReason: "blocked by test hook",
      })),
    };
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
    });

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-backend-cwd-vetoed-before-validation",
      {
        command: "echo ok",
        workdir: "/remote/workspace/generated",
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect(
      result.details as { status?: unknown; deniedReason?: unknown } | undefined,
    ).toMatchObject({
      status: "blocked",
      deniedReason: "plugin-before-tool-call",
    });
    expect(mocks.hookRunner.runBeforeToolCall!).toHaveBeenCalledOnce();
    expect(validateWorkdir).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("defers resolve_exec_env for backend sandboxes until workdir validation succeeds", async () => {
    const validateWorkdir = vi.fn(async () => null);
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async () => ({ PLUGIN_SAFE: "yes" })),
      runBeforeToolCall: vi.fn(async () => undefined),
    };
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
    });

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-backend-invalid-cwd-before-env",
      {
        command: "echo ok",
        workdir: "/remote/workspace/missing",
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(mocks.hookRunner.runBeforeToolCall!).toHaveBeenCalledOnce();
    expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/missing");
    expect(mocks.hookRunner.runResolveExecEnv!).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("preserves hook context when backend sandbox env resolution is deferred", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
      async (params) => ({
        argv: ["remote-shell", params.command],
        env: {},
        stdinMode: "pipe-open" as const,
      }),
    );
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async () => ({ PLUGIN_SAFE: "yes" })),
      runBeforeToolCall: vi.fn(async () => undefined),
    };
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
        buildExecSpec,
      },
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "ctx-agent",
      sessionKey: "agent:ctx-agent:telegram:chat-2",
      channelId: "ctx-channel",
    });

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-backend-deferred-env-context",
      {
        command: "echo ok",
        workdir: "/remote/workspace/generated",
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("completed");
    expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/generated");
    expect(mocks.hookRunner.runBeforeToolCall!).toHaveBeenCalledOnce();
    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenCalledOnce();
    expect(mocks.hookRunner.runResolveExecEnv!.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:ctx-agent:telegram:chat-2",
      toolName: "exec",
      host: "sandbox",
    });
    expect(mocks.hookRunner.runResolveExecEnv!.mock.calls[0]?.[1]).toMatchObject({
      agentId: "ctx-agent",
      sessionKey: "agent:ctx-agent:telegram:chat-2",
      channelId: "ctx-channel",
    });
    expect(buildExecSpec.mock.calls[0]?.[0]?.env).toMatchObject({
      PLUGIN_SAFE: "yes",
    });
  });

  it("lets lazy before_tool_call see invalid workdirs before failing unchanged params", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async () => ({ LAZY_PLUGIN_SAFE: "yes" })),
      runBeforeToolCall: vi.fn(async () => undefined),
    };

    const exec = createOpenClawCodingTools({
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
      cwd: process.cwd(),
      exec: { host: "gateway", security: "full", ask: "off" },
    }).find((tool) => tool.name === "exec");
    expect(exec).toBeDefined();
    const [definition] = toToolDefinitions([exec!], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
      channelId: "chat-1",
    });

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-invalid-lazy-cwd-before-hooks",
      {
        command: "echo ok",
        workdir: "   ",
      },
      undefined,
      undefined,
      testExtensionContext,
    );
    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";

    expect((result.details as { status?: unknown } | undefined)?.status).toBe("failed");
    expect(text).toContain('workdir "   " is unavailable or not a directory');
    expect(mocks.hookRunner.runBeforeToolCall!).toHaveBeenCalledTimes(1);
    expect(mocks.hookRunner.runResolveExecEnv!).not.toHaveBeenCalled();
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("forwards explicit node host workdirs without local gateway validation", async () => {
    const remoteWorkdir = "/remote/node/workspace";
    const tool = createExecTool({
      host: "node",
      security: "full",
      ask: "off",
    });

    await tool.execute("call-node-explicit-cwd", {
      command: "echo ok",
      workdir: remoteWorkdir,
    });

    expect(mocks.nodeHostParams[0]?.workdir).toBe(remoteWorkdir);
  });

  it("keeps plugin env out of before_tool_call params before execution", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async () => ({ PLUGIN_SAFE: "yes" })),
      runBeforeToolCall: vi.fn(async (event: { params: Record<string, unknown> }) => {
        expect(Object.getOwnPropertySymbols(event.params)).toHaveLength(0);
        mocks.beforeToolCallParams.push({ ...event.params });
        return undefined;
      }),
    };

    const tool = createExecTool({
      host: "auto",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
      messageProvider: "telegram",
      currentChannelId: "chat-1",
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
      channelId: "chat-1",
    });

    await expectDefined(definition, "definition test invariant").execute(
      "call-before",
      {
        command: "echo ok",
        env: { EXISTING: "request" },
        yieldMs: 120_000,
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect(mocks.beforeToolCallParams[0]?.env).toEqual({
      EXISTING: "request",
    });
    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      EXISTING: "request",
      PLUGIN_SAFE: "yes",
    });
  });

  it("forwards private env preparation through the lazy exec tool", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async () => ({ LAZY_PLUGIN_SAFE: "yes" })),
      runBeforeToolCall: vi.fn(async (event: { params: Record<string, unknown> }) => {
        expect(Object.getOwnPropertySymbols(event.params)).toHaveLength(0);
        mocks.beforeToolCallParams.push({ ...event.params });
        return undefined;
      }),
    };

    const exec = createOpenClawCodingTools({
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
      cwd: process.cwd(),
      exec: { host: "gateway", security: "full", ask: "off" },
    }).find((tool) => tool.name === "exec");
    expect(exec).toBeDefined();
    const [definition] = toToolDefinitions([exec!], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
      channelId: "chat-1",
    });

    await expectDefined(definition, "definition test invariant").execute(
      "call-lazy",
      {
        command: "echo ok",
        env: { REQUEST_SAFE: "request" },
        yieldMs: 120_000,
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect(mocks.beforeToolCallParams[0]?.env).toEqual({
      REQUEST_SAFE: "request",
    });
    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      LAZY_PLUGIN_SAFE: "yes",
      REQUEST_SAFE: "request",
    });
  });

  it("recomputes plugin env when before_tool_call changes exec host", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async (event: { host: "gateway" | "sandbox" | "node" }) =>
        event.host === "node" ? { NODE_PLUGIN_SAFE: "node" } : { GATEWAY_PLUGIN_SAFE: "gateway" },
      ),
      runBeforeToolCall: vi.fn(async (event: { params: Record<string, unknown> }) => ({
        params: { ...event.params, host: "node" },
      })),
    };

    const tool = createExecTool({
      host: "auto",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
    });

    await expectDefined(definition, "definition test invariant").execute(
      "call-host-rewrite",
      {
        command: "echo ok",
        env: { REQUEST_SAFE: "request" },
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenCalledTimes(2);
    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ host: "gateway" }),
      expect.anything(),
    );
    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ host: "node" }),
      expect.anything(),
    );
    expect(mocks.nodeHostParams[0]?.requestedEnv).toEqual({
      NODE_PLUGIN_SAFE: "node",
      REQUEST_SAFE: "request",
    });
    expect(mocks.nodeHostParams[0]?.requestedEnv).not.toHaveProperty("GATEWAY_PLUGIN_SAFE");
  });

  it("lets before_tool_call reroute gateway-invalid workdirs to node host execution", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async (event: { host: "gateway" | "sandbox" | "node" }) =>
        event.host === "node" ? { NODE_PLUGIN_SAFE: "node" } : { GATEWAY_PLUGIN_SAFE: "gateway" },
      ),
      runBeforeToolCall: vi.fn(async (event: { params: Record<string, unknown> }) => ({
        params: { ...event.params, host: "node" },
      })),
    };

    const tool = createExecTool({
      host: "auto",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
    });

    await expectDefined(definition, "definition test invariant").execute(
      "call-host-rewrite-with-remote-cwd",
      {
        command: "echo ok",
        env: { REQUEST_SAFE: "request" },
        workdir: "/remote/node/workspace",
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect(mocks.hookRunner.runBeforeToolCall!).toHaveBeenCalledOnce();
    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenCalledOnce();
    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenCalledWith(
      expect.objectContaining({ host: "node" }),
      expect.anything(),
    );
    expect(mocks.nodeHostParams[0]?.requestedEnv).toEqual({
      NODE_PLUGIN_SAFE: "node",
      REQUEST_SAFE: "request",
    });
    expect(mocks.nodeHostParams[0]?.workdir).toBe("/remote/node/workspace");
    expect(mocks.gatewayParams).toHaveLength(0);
    expect(mocks.spawnInputs).toHaveLength(0);
  });

  it("lets before_tool_call rewrite host when no resolve_exec_env hook is registered", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_tool_call"),
      runResolveExecEnv: vi.fn(),
      runBeforeToolCall: vi.fn(async (event: { params: Record<string, unknown> }) => ({
        params: { ...event.params, host: "gateway" },
      })),
    };

    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
    });

    await expectDefined(definition, "definition test invariant").execute(
      "call-host-sanitize",
      {
        command: "echo ok",
        host: "node",
        env: { REQUEST_SAFE: "request" },
        yieldMs: 120_000,
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect(mocks.hookRunner.runResolveExecEnv!).not.toHaveBeenCalled();
    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      REQUEST_SAFE: "request",
    });
  });

  it("skips stale hook runners that report resolve_exec_env without the runner method", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "resolve_exec_env"),
    };

    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
    });
    await tool.execute("call-stale-hook-runner", {
      command: "echo ok",
      env: { REQUEST_SAFE: "request" },
      yieldMs: 120_000,
    });

    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      REQUEST_SAFE: "request",
    });
  });

  it("resolves plugin env after before_tool_call adds a command", async () => {
    mocks.hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) => hookName === "resolve_exec_env" || hookName === "before_tool_call",
      ),
      runResolveExecEnv: vi.fn(async () => ({ PLUGIN_SAFE: "yes" })),
      runBeforeToolCall: vi.fn(async (event: { params: Record<string, unknown> }) => {
        mocks.beforeToolCallParams.push({ ...event.params });
        return {
          params: { ...event.params, command: "echo ok" },
        };
      }),
    };

    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:chat-1",
    });
    const [definition] = toToolDefinitions([tool], {
      agentId: "main",
      sessionKey: "agent:main:telegram:chat-1",
    });

    await expectDefined(definition, "definition test invariant").execute(
      "call-command-rewrite",
      {
        env: { REQUEST_SAFE: "request" },
        yieldMs: 120_000,
      },
      undefined,
      undefined,
      testExtensionContext,
    );

    expect(mocks.beforeToolCallParams[0]?.env).toEqual({
      REQUEST_SAFE: "request",
    });
    expect(mocks.hookRunner.runResolveExecEnv!).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayParams[0]?.requestedEnv).toEqual({
      PLUGIN_SAFE: "yes",
      REQUEST_SAFE: "request",
    });
  });
});
