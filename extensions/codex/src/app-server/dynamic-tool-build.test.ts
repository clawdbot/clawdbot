// Codex tests cover dynamic tool build plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  isToolWrappedWithBeforeToolCallHook,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  getActivePluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import {
  buildDynamicTools,
  disableCodexPluginThreadConfig,
  resolveCodexAppServerExecutionCwd,
  resolveCodexExternalSandboxPolicyForOpenClawSandbox,
  resolveCodexMessageToolProvider,
  resolveCodexSandboxEnvironmentSelection,
  shouldEnableCodexAppServerNativeToolSurface,
} from "./dynamic-tool-build.js";
import {
  filterCodexDynamicTools,
  filterCodexDynamicToolsForDisabledNativeSurface,
  resolveCodexDynamicToolsLoading,
  resolveCodexDynamicToolsLoadingForRuntime,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import * as nativeExecutionPolicy from "./native-execution-policy.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  flattenCodexDynamicToolFunctions,
} from "./protocol.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import { createCodexTestModel } from "./test-support.js";

const hoisted = vi.hoisted(() => ({
  normalizeAgentRuntimeTools: vi.fn(),
  resolveWebSearchToolPolicy: vi.fn(),
  loadNodeExecAvailability: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness")>();

  return {
    ...actual,
    resolveWebSearchToolPolicy: (
      ...args: Parameters<(typeof actual)["resolveWebSearchToolPolicy"]>
    ) => {
      hoisted.resolveWebSearchToolPolicy(...args);
      return actual.resolveWebSearchToolPolicy(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    normalizeAgentRuntimeTools: (...args: Parameters<typeof actual.normalizeAgentRuntimeTools>) => {
      hoisted.normalizeAgentRuntimeTools(...args);
      return actual.normalizeAgentRuntimeTools(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/node-selection-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/node-selection-runtime")>();
  return { ...actual, loadNodeExecAvailability: hoisted.loadNodeExecAvailability };
});

let tempDir: string;
const hostCapabilityClosers: Array<() => void> = [];

function setOpenClawCodingToolsFactoryForTests(
  factory: NonNullable<typeof dynamicToolBuildState.openClawCodingToolsFactory>,
): void {
  dynamicToolBuildState.openClawCodingToolsFactory = factory;
}

function resetOpenClawCodingToolsFactoryForTests(): void {
  dynamicToolBuildState.openClawCodingToolsFactory = undefined;
}

async function bindProductionCodexHostCapabilities(
  params: EmbeddedRunAttemptParams,
): Promise<void> {
  const { hostCapabilities: _hostCapabilities, ...attempt } = params;
  const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "codex" });
  params.hostCapabilities = host.capabilities;
  hostCapabilityClosers.push(host.close);
}

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    contextTokenBudget: 150_000,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "agentContextTokens",
    },
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function createCodexRuntimePlanFixture(): NonNullable<EmbeddedRunAttemptParams["runtimePlan"]> {
  return {
    auth: {},
    observability: {
      resolvedRef: "codex/gpt-5.4-codex",
      provider: "codex",
      modelId: "gpt-5.4-codex",
      harnessId: "codex",
    },
    prompt: {
      resolveSystemPromptContribution: () => undefined,
    },
    tools: {
      normalize: (tools: unknown[]) => tools,
      logDiagnostics: () => undefined,
    },
  } as unknown as NonNullable<EmbeddedRunAttemptParams["runtimePlan"]>;
}

function createRuntimeDynamicTool(name: string): RuntimeDynamicToolForTest {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: `${name} done` }],
      details: {},
    })),
  };
}

function shellTestToolNames(tools: readonly { name: string }[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => ["message", "gateway_exec", "gateway_process", "node_exec"].includes(name));
}

async function buildDynamicToolsForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
  options: Partial<Parameters<typeof buildDynamicTools>[0]> = {},
) {
  const sandboxSessionKey = params.sessionKey;
  if (!sandboxSessionKey) {
    throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
  }
  return buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sandboxSessionKey,
    sandbox: { enabled: false, backendId: "docker" } as never,
    ...(params.permissionMode && params.sessionRoot
      ? {
          sessionPermissionPolicy: {
            mode: params.permissionMode,
            root: params.sessionRoot,
            execMode:
              params.permissionMode === "read-only"
                ? "deny"
                : params.permissionMode === "guarded"
                  ? "ask"
                  : params.permissionMode === "workspace"
                    ? "auto"
                    : "full",
          },
        }
      : {}),
    nativeToolSurfaceEnabled: true,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    policyAgentId: params.sandboxAgentId ?? options.sessionAgentId ?? "main",
    pluginConfig: {},
    onYieldDetected: () => undefined,
    ...options,
  });
}

describe("Codex app-server dynamic tool build", () => {
  it("forwards the explicit yield acknowledgment without exposing private context", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    let capturedOnYield:
      | ((message: string, acknowledgment?: string) => Promise<void> | void)
      | undefined;
    setOpenClawCodingToolsFactoryForTests((options) => {
      capturedOnYield = (options as { onYield?: typeof capturedOnYield }).onYield;
      return [];
    });
    const onYieldDetected = vi.fn();

    await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null as never,
      onYieldDetected,
    });
    await expectDefined(capturedOnYield, "captured onYield callback")(
      "Resume after the fact-checker replies",
      "Research started; results will follow.",
    );

    expect(onYieldDetected).toHaveBeenCalledWith("Research started; results will follow.");
  });

  it("binds a resolver-backed constructed tool surface exactly once", async () => {
    const workspaceDir = path.join(tempDir, "resolver-bound-workspace");
    const params = createParams(path.join(tempDir, "resolver-bound-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const bindToolSurface = vi.fn(params.hostCapabilities.bindToolSurface);
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      bindToolSurface,
    });
    const factory = vi.fn(() => [createRuntimeDynamicTool("read")]);
    setOpenClawCodingToolsFactoryForTests(factory);
    const resolveCronCreatorToolAuthority = vi.fn(async () => ({
      tools: ["read"],
      provenance: { version: 1 as const, source: "final-executable-surface" as const },
    }));
    const effectiveCwd = path.join(workspaceDir, "native-cwd");

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      effectiveCwd,
      resolveCronCreatorToolAuthority,
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(bindToolSurface).toHaveBeenCalledOnce();
    expect(bindToolSurface).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "read" })]),
      { cwd: effectiveCwd },
    );
    expect(tools).toEqual([]);
  });

  it("keeps host and plugin tools while native paired-device execution owns filesystem and shell", async () => {
    const workspaceDir = path.join(tempDir, "paired-node-workspace");
    const params = createParams(path.join(tempDir, "paired-node-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factory = vi.fn((options: Parameters<typeof createOpenClawCodingTools>[0]) => [
      ...createOpenClawCodingTools(options).filter((tool) => tool.name === "message"),
      createRuntimeDynamicTool("paired_host_plugin"),
    ]);
    setOpenClawCodingToolsFactoryForTests(factory);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: {
        enabled: true,
        backendId: "node",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/remote/workspace",
        workspaceAccess: "rw",
        browserAllowHostControl: false,
        placementExecutionMode: "remote-exec",
        placementNodeId: "paired-device-1",
      } as never,
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["message", "paired_host_plugin"]),
    );
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: true,
          includeOpenClawTools: true,
          includePluginTools: true,
        },
      }),
    );
  });

  it("fails paired-device execution visibly when native execution is unavailable", async () => {
    const workspaceDir = path.join(tempDir, "paired-node-workspace");
    const params = createParams(path.join(tempDir, "paired-node-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factory = vi.fn(() => [createRuntimeDynamicTool("exec")]);
    setOpenClawCodingToolsFactoryForTests(factory);

    await expect(
      buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: {
          enabled: true,
          backendId: "node",
          placementExecutionMode: "remote-exec",
          placementNodeId: "paired-device-1",
        } as never,
        nativeToolSurfaceEnabled: false,
      }),
    ).rejects.toThrow("requires its native exec-server tool surface");
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses the prepared explicit-policy fact to disable the native surface", () => {
    const params = createParams("/tmp/session.jsonl", "/tmp/workspace");
    params.disableTools = false;

    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(true);
    params.config = { tools: { profile: "coding" } };
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(true);
    params.conversationToolPolicy = { deny: ["exec"] };
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(true);
    params.pluginHarnessToolPolicyRestricted = true;
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(false);
  });

  it("keeps policy-filterable OpenClaw coding replacements when native tools are disabled", () => {
    const tools = [
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "progress_card",
      "get_goal",
      "create_goal",
      "update_goal",
      "message",
    ].map((name) => ({ name }));

    expect(
      filterCodexDynamicToolsForDisabledNativeSurface(tools, {}, { preserveShell: true }).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "progress_card",
      "get_goal",
      "create_goal",
      "update_goal",
      "message",
    ]);
    expect(
      filterCodexDynamicToolsForDisabledNativeSurface(
        tools,
        { codexDynamicToolsExclude: ["write", "apply_patch"] },
        { preserveShell: false },
      ).map((tool) => tool.name),
    ).toEqual([
      "read",
      "edit",
      "progress_card",
      "get_goal",
      "create_goal",
      "update_goal",
      "message",
    ]);
  });

  const policyDeny = ["exec", "process", "write", "edit"];
  it.each<{
    source: string;
    config?: EmbeddedRunAttemptParams["config"];
    conversationToolPolicy?: EmbeddedRunAttemptParams["conversationToolPolicy"];
    sandboxAgentId?: string;
    denied: boolean;
  }>([
    { source: "allowed", sandboxAgentId: "policy", denied: false },
    { source: "conversation", conversationToolPolicy: { deny: policyDeny }, denied: true },
    {
      source: "intersection",
      conversationToolPolicy: { deny: policyDeny },
      config: { tools: { deny: ["apply_patch"] } },
      denied: true,
    },
    { source: "global", config: { tools: { deny: policyDeny } }, denied: true },
    {
      source: "execution owner",
      config: { agents: { entries: { main: { tools: { deny: policyDeny } } } } },
      denied: true,
    },
    {
      source: "retained owner",
      config: { agents: { entries: { main: {}, policy: { tools: { deny: policyDeny } } } } },
      sandboxAgentId: "policy",
      denied: true,
    },
  ])(
    "enforces $source policy when a dynamic write reaches the bridge",
    async ({ source, config, conversationToolPolicy, sandboxAgentId, denied }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const targetPath = path.join(workspaceDir, "policy-write.txt");
      const params = createParams(path.join(tempDir, "policy-session.jsonl"), workspaceDir);
      params.agentId = "main";
      params.sandboxSessionKey = sandboxAgentId ? "global" : undefined;
      params.sandboxAgentId = sandboxAgentId;
      params.conversationToolPolicy = conversationToolPolicy;
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = {
        plugins: { enabled: false },
        agents: config?.agents ?? { entries: { main: {}, policy: {} } },
        tools: { ...config?.tools, fs: { workspaceOnly: true } },
      };
      const beforeToolCall = vi.fn(() => ({}));
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
      );
      try {
        await bindProductionCodexHostCapabilities(params);
        setOpenClawCodingToolsFactoryForTests((options) =>
          createOpenClawCodingTools(options).filter((tool) =>
            ["read", "write", "edit", "apply_patch", "exec", "process"].includes(tool.name),
          ),
        );
        const tools = await buildDynamicToolsForTest(params, workspaceDir, {
          sandboxSessionKey: params.sandboxSessionKey ?? params.sessionKey,
          nativeToolSurfaceEnabled: false,
          sandbox: null,
        });
        const bridge = createCodexDynamicToolBridge({
          tools,
          signal: new AbortController().signal,
          loading: "direct",
          hookContext: {
            agentId: "main",
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            runId: params.runId,
            workspaceDir,
          },
        });
        const result = await bridge.handleToolCall({
          threadId: "thread-policy",
          turnId: "turn-policy",
          callId: "write-policy",
          tool: "write",
          arguments: { path: targetPath, content: "allowed owner write" },
        });
        if (denied) {
          await expect(fs.readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          expect(result.success).toBe(false);
          expect(beforeToolCall).not.toHaveBeenCalled();
          expect(tools.map((tool) => tool.name).toSorted()).toEqual(
            source === "intersection" ? ["read"] : ["apply_patch", "read"],
          );
          const nativeTools = await buildDynamicToolsForTest(params, workspaceDir, {
            sandboxSessionKey: params.sandboxSessionKey ?? params.sessionKey,
          });
          expect(nativeTools.map((tool) => tool.name)).not.toContain("gateway_exec");
          expect(nativeTools.map((tool) => tool.name)).not.toContain("gateway_process");
        } else {
          expect(result.success).toBe(true);
          await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("allowed owner write");
          expect(beforeToolCall).toHaveBeenCalledWith(
            expect.objectContaining({ toolName: "write" }),
            expect.objectContaining({ agentId: "main", sessionKey: params.sessionKey }),
          );
        }
      } finally {
        resetGlobalHookRunner();
      }
    },
  );

  it("removes account-wide app access when native tools are restricted", () => {
    expect(
      disableCodexPluginThreadConfig({
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "auto",
        },
      }),
    ).toEqual({
      codexPlugins: {
        enabled: false,
        allow_all_plugins: true,
        allow_destructive_actions: "auto",
      },
    });
  });

  beforeEach(async () => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    hoisted.normalizeAgentRuntimeTools.mockClear();
    hoisted.resolveWebSearchToolPolicy.mockClear();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-tools-"));
  });

  afterEach(async () => {
    for (const close of hostCapabilityClosers.splice(0)) {
      close();
    }
    resetOpenClawCodingToolsFactoryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses the message tool channel before a differing ingress provider", () => {
    expect(
      resolveCodexMessageToolProvider({
        messageChannel: "discord",
        messageProvider: "discord-voice",
      }),
    ).toBe("discord");
  });

  const sandboxEnvironment = { environmentId: "sandbox-1", cwd: "/workspace" };

  it.each([
    {
      name: "restricted without a sandbox",
      environment: undefined,
      nativeToolSurfaceEnabled: false,
      expected: [],
    },
    {
      name: "restricted with a sandbox",
      environment: sandboxEnvironment,
      nativeToolSurfaceEnabled: false,
      expected: [],
    },
    {
      name: "native without a sandbox",
      environment: undefined,
      nativeToolSurfaceEnabled: true,
      expected: undefined,
    },
    {
      name: "native with a sandbox",
      environment: sandboxEnvironment,
      nativeToolSurfaceEnabled: true,
      expected: [sandboxEnvironment],
    },
  ])("preserves the explicit Codex environment selection when $name", (testCase) => {
    expect(
      resolveCodexSandboxEnvironmentSelection(
        testCase.environment,
        testCase.nativeToolSurfaceEnabled,
      ),
    ).toEqual(testCase.expected);
  });

  it("maps sandbox exec-server cwd through the remote workspace mapping", () => {
    expect(
      resolveCodexAppServerExecutionCwd({
        effectiveCwd: "/Users/kevinlin/code/openclaw",
        environment: {
          id: "sandbox-1",
          cwd: "/Users/kevinlin/code/openclaw/sandbox",
        } as never,
        nativeToolSurfaceEnabled: true,
        localWorkspaceRoot: "/Users/kevinlin/code/openclaw",
        remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
      }),
    ).toBe("/home/oai/openclaw-workspaces/sandbox");
  });

  it("filters Codex-native dynamic tools from app-server tool exposure", () => {
    const tools = [
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "update_plan",
      "progress_card",
      "get_goal",
      "create_goal",
      "update_goal",
      "tool_call",
      "tool_describe",
      "tool_search",
      "tool_search_code",
      "web_search",
      "message",
      "heartbeat_respond",
      "sessions_spawn",
    ].map((name) => ({ name }));

    expect(filterCodexDynamicTools(tools, {}).map((tool) => tool.name)).toEqual([
      "progress_card",
      "web_search",
      "message",
      "heartbeat_respond",
      "sessions_spawn",
    ]);
  });

  it.each([
    { nativeToolSurfaceEnabled: true, expected: ["message"] },
    { nativeToolSurfaceEnabled: false, expected: ["view_image", "message"] },
  ])(
    "uses the active native image loader when native tools are $nativeToolSurfaceEnabled",
    async ({ nativeToolSurfaceEnabled, expected }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.disableTools = false;
      params.model = createCodexTestModel("codex", ["text", "image"]);
      params.runtimePlan = createCodexRuntimePlanFixture();
      setOpenClawCodingToolsFactoryForTests(() => [
        createRuntimeDynamicTool("view_image"),
        createRuntimeDynamicTool("message"),
      ]);

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        nativeToolSurfaceEnabled,
      });

      expect(tools.map((tool) => tool.name)).toEqual(expected);
    },
  );

  it("never lets raw full bypass a requirements-clamped workspace dynamic policy", async () => {
    const workspaceDir = path.join(tempDir, "clamped-workspace");
    const params = createParams(path.join(tempDir, "clamped-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.permissionMode = "full";
    params.sessionRoot = workspaceDir;
    params.execOverrides = { host: "gateway", mode: "full" };
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null as never,
      sessionPermissionPolicy: { mode: "workspace", root: workspaceDir, execMode: "auto" },
    });

    expect(factoryOptions[0]).toMatchObject({
      exec: { host: "gateway", mode: "auto" },
      sessionPermissionPolicy: { mode: "workspace", root: workspaceDir },
    });
  });

  it("pins guarded Gateway shell calls to human approval after stripping model policy", async () => {
    const workspaceDir = path.join(tempDir, "guarded-gateway-workspace");
    const params = createParams(path.join(tempDir, "guarded-gateway.jsonl"), workspaceDir);
    params.disableTools = false;
    params.permissionMode = "guarded";
    params.sessionRoot = workspaceDir;
    params.execOverrides = { host: "gateway", mode: "ask" };
    params.runtimePlan = createCodexRuntimePlanFixture();
    await bindProductionCodexHostCapabilities(params);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sessionPermissionPolicy: { mode: "guarded", root: workspaceDir, execMode: "ask" },
    });
    const gatewayExec = expectDefined(
      tools.find((tool) => tool.name === "gateway_exec"),
      "guarded Gateway shell alias",
    );
    expect(gatewayExec.parameters).not.toHaveProperty("properties.host");
    expect(gatewayExec.parameters).not.toHaveProperty("properties.security");
    expect(gatewayExec.parameters).not.toHaveProperty("properties.ask");
  });

  it.each([
    {
      mode: "guarded" as const,
      execMode: "ask" as const,
      command: "echo allowed",
      expected: { status: "completed" },
    },
    {
      mode: "guarded" as const,
      execMode: "ask" as const,
      command: "echo approval required",
      expected: { status: "failed", failureKind: "approval_required" },
    },
    {
      mode: "full" as const,
      execMode: "full" as const,
      command: "echo approval required",
      expected: { status: "completed" },
    },
  ])("enforces $mode collector policy for $command", async (testCase) => {
    const workspaceDir = path.join(tempDir, `${testCase.mode}-allowlisted-workspace`);
    await fs.mkdir(workspaceDir, { recursive: true });
    const params = createParams(
      path.join(tempDir, `${testCase.mode}-allowlisted.jsonl`),
      workspaceDir,
    );
    params.disableTools = false;
    params.swarmCollector = true;
    params.pluginHarnessToolPolicyRestricted = true;
    params.permissionMode = testCase.mode;
    params.sessionRoot = workspaceDir;
    params.execOverrides = { host: "gateway", mode: testCase.execMode };
    // Guarded mode asks only on an allowlist miss; two arguments exceed this profile.
    params.config = {
      tools: { exec: { safeBins: ["echo"], safeBinProfiles: { echo: { maxPositional: 1 } } } },
    };
    params.runtimePlan = createCodexRuntimePlanFixture();
    setOpenClawCodingToolsFactoryForTests((options) =>
      createOpenClawCodingTools(options).filter((tool) => ["exec", "process"].includes(tool.name)),
    );

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: shouldEnableCodexAppServerNativeToolSurface(params),
      sessionPermissionPolicy: {
        mode: testCase.mode,
        root: workspaceDir,
        execMode: testCase.execMode,
      },
    });
    const gatewayExec = expectDefined(
      tools.find((tool) => tool.name === "exec"),
      `${testCase.mode} OpenClaw shell replacement`,
    );
    expect.soft(gatewayExec.parameters).not.toHaveProperty("properties.security");
    const result = await gatewayExec.execute(`${testCase.mode}-allowlisted`, {
      command: testCase.command,
      ask: "off",
      security: "full",
    });

    expect(result.details).toMatchObject(testCase.expected);
  });

  it("removes managed web_search when domain-restricted Codex hosted search is active", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.config = {
      tools: {
        web: {
          search: { openaiCodex: { allowedDomains: ["example.com"] } },
        },
      },
    } as never;
    let receivedOptions: Record<string, unknown> | undefined;
    setOpenClawCodingToolsFactoryForTests((options) => {
      receivedOptions = options as Record<string, unknown>;
      return [
        createRuntimeDynamicTool("web_search"),
        createRuntimeDynamicTool("web_fetch"),
        createRuntimeDynamicTool("message"),
      ];
    });
    let webSearchAllowed = false;

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      onWebSearchPolicyResolved: (allowed) => {
        webSearchAllowed = allowed;
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["web_fetch", "message"]);
    expect(
      (receivedOptions?.webFetchHostnameAllowlistRef as { value?: string[] } | undefined)?.value,
    ).toEqual(["example.com", "*.example.com"]);
    expect(webSearchAllowed).toBe(true);
  });

  it.each([
    {
      name: "a managed search provider is selected",
      search: { provider: "brave", openaiCodex: { allowedDomains: ["example.com"] } },
      toolsAllow: undefined,
    },
    {
      name: "the native search allowlist is empty",
      search: { openaiCodex: { allowedDomains: [] } },
      toolsAllow: undefined,
    },
    {
      name: "effective tool policy disables hosted search",
      search: { openaiCodex: { allowedDomains: ["example.com"] } },
      toolsAllow: ["web_fetch"],
    },
  ])("leaves web_fetch unrestricted when $name", async ({ search, toolsAllow }) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = toolsAllow;
    params.config = { tools: { web: { search } } } as never;
    let receivedOptions: Record<string, unknown> | undefined;
    setOpenClawCodingToolsFactoryForTests((options) => {
      receivedOptions = options as Record<string, unknown>;
      return [createRuntimeDynamicTool("web_search"), createRuntimeDynamicTool("web_fetch")];
    });

    await buildDynamicToolsForTest(params, workspaceDir);

    expect(
      (receivedOptions?.webFetchHostnameAllowlistRef as { value?: string[] } | undefined)?.value,
    ).toBeUndefined();
  });

  it.each([
    {
      name: "publication capability is unavailable",
      githubPublicationAvailable: undefined,
      profile: "coding",
      expectedTools: [],
    },
    {
      name: "publication is unavailable for a prepared session",
      githubPublicationAvailable: false,
      profile: "coding",
      expectedTools: ["github_identity_status"],
    },
    {
      name: "publication is available for a prepared session",
      githubPublicationAvailable: true,
      profile: "coding",
      expectedTools: ["github_identity_status", "github_publish"],
    },
    {
      name: "the active profile excludes coding tools",
      githubPublicationAvailable: true,
      profile: "messaging",
      expectedTools: [],
    },
  ] as const)(
    "exposes prepared GitHub tools when $name",
    async ({ githubPublicationAvailable, profile, expectedTools }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.disableTools = false;
      params.githubPublicationAvailable = githubPublicationAvailable;
      params.config = { tools: { profile } };
      params.runtimePlan = createCodexRuntimePlanFixture();
      const { hostCapabilities: _hostCapabilities, ...attempt } = params;
      const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "codex" });
      params.hostCapabilities = host.capabilities;

      try {
        const tools = await buildDynamicToolsForTest(params, workspaceDir, {
          sandbox: null as never,
        });

        expect(tools.map((tool) => tool.name).filter((name) => name.startsWith("github_"))).toEqual(
          expectedTools,
        );
      } finally {
        host.close();
      }
    },
  );

  it("forwards client caps alongside channel authority context", async () => {
    // Regression: capability-gated tools (requiredClientCaps) vanished on the
    // Codex app-server path because this harness dropped params.clientCaps.
    // Keep that fact composed with the operation-local message context.
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.clientCaps = ["tool-events", "inline-widgets"];
    params.chatId = "native-chat-123";
    params.chatType = "direct";
    params.messageActionTurnCapability = "turn-capability-1";
    let receivedOptions: unknown;
    setOpenClawCodingToolsFactoryForTests((options) => {
      receivedOptions = options;
      return [createRuntimeDynamicTool("message")];
    });

    await buildDynamicToolsForTest(params, workspaceDir);

    expect(receivedOptions).toMatchObject({
      clientCaps: ["tool-events", "inline-widgets"],
      chatType: "direct",
      nativeChannelId: "native-chat-123",
      messageActionTurnCapability: "turn-capability-1",
    });
  });

  it("forwards the task-suggestion delivery mode", async () => {
    // Regression: suggest_task/dismiss_task silently never existed on the Codex
    // app-server path because this harness dropped params.taskSuggestionDeliveryMode.
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.taskSuggestionDeliveryMode = "gateway";
    let receivedOptions: unknown;
    setOpenClawCodingToolsFactoryForTests((options) => {
      receivedOptions = options;
      return [createRuntimeDynamicTool("message")];
    });

    await buildDynamicToolsForTest(params, workspaceDir);

    expect(receivedOptions).toMatchObject({ taskSuggestionDeliveryMode: "gateway" });
  });

  it.each([{ toolsAllow: undefined }, { toolsAllow: ["read"] }, { toolsAllow: [] }])(
    "preserves the collector handoff and dynamic tool through allowlist %j",
    async ({ toolsAllow }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "collector-session.jsonl"), workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.toolsAllow = toolsAllow;
      params.swarmCollector = true;
      params.pluginHarnessToolPolicyRestricted = true;
      params.swarmOutputSchema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      };
      // An independent host result: the factory must not repair dropped attempt fields.
      const output = {
        ...createRuntimeDynamicTool("structured_output"),
        catalogMode: "direct-only" as const,
      };
      const factory = vi.fn(() => [createRuntimeDynamicTool("read"), output]);
      setOpenClawCodingToolsFactoryForTests(factory);
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null,
        nativeToolSurfaceEnabled: shouldEnableCodexAppServerNativeToolSurface(params),
      });

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          swarmCollector: true,
          swarmOutputSchema: params.swarmOutputSchema,
          ...(toolsAllow ? { runtimeToolAllowlist: [...toolsAllow, "structured_output"] } : {}),
        }),
      );
      expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(false);
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(
        [...(toolsAllow ?? ["read"]), "structured_output"].toSorted(),
      );
      const bridge = createCodexDynamicToolBridge({
        tools,
        signal: new AbortController().signal,
      });
      const outputSpec = expectDefined(
        flattenCodexDynamicToolFunctions(bridge.specs).find(
          (tool) => tool.name === "structured_output",
        ),
        "collector dynamic tool spec",
      );
      expect(outputSpec.deferLoading).not.toBe(true);
      const args = { result: { answer: "ok" } };
      const response = await bridge.handleToolCall({
        threadId: "collector-thread",
        turnId: "collector-turn",
        tool: "structured_output",
        callId: "collector-result",
        arguments: args,
      });
      expect(response).toMatchObject({
        success: true,
        contentItems: [{ type: "inputText", text: "structured_output done" }],
      });
      expect(output.execute).toHaveBeenCalledWith(
        "collector-result",
        args,
        expect.any(AbortSignal),
        undefined,
      );
    },
  );

  it.each(["searchable", "direct"] as const)(
    "keeps regular delegation model-only with %s loading while ordinary tools stay scriptable",
    async (loading) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = { tools: { exec: { mode: "ask" } } };
      setOpenClawCodingToolsFactoryForTests((options) =>
        createOpenClawCodingTools(options).filter((tool) =>
          ["openclaw", "message"].includes(tool.name),
        ),
      );

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null,
        isHostScopedToolActive: () => false,
      });
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(["message", "openclaw"]);
      const bridge = createCodexDynamicToolBridge({
        tools,
        signal: new AbortController().signal,
        loading,
        directToolNames: resolveCodexDynamicToolDirectNames(params, false),
      });

      expect(bridge.specs).toContainEqual({
        type: "namespace",
        name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
        description: "",
        tools: [expect.objectContaining({ type: "function", name: "openclaw" })],
      });
      const ordinarySpec = expect.objectContaining({ type: "function", name: "message" });
      expect(bridge.specs).toContainEqual(
        loading === "direct"
          ? ordinarySpec
          : {
              type: "namespace",
              name: "openclaw",
              description: "",
              tools: [expect.objectContaining({ name: "message", deferLoading: true })],
            },
      );
    },
  );

  it.each(["core policy", "Codex excludes", "turn allowlist"])(
    "filters the real regular delegate when denied by %s",
    async (policy) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = policy === "core policy" ? { tools: { deny: ["openclaw"] } } : {};
      params.toolsAllow = policy === "turn allowlist" ? ["message"] : ["openclaw", "message"];
      setOpenClawCodingToolsFactoryForTests((options) =>
        createOpenClawCodingTools(options).filter((tool) =>
          ["openclaw", "message"].includes(tool.name),
        ),
      );

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null,
        isHostScopedToolActive: () => false,
        pluginConfig: policy === "Codex excludes" ? { codexDynamicToolsExclude: ["openclaw"] } : {},
      });

      expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    },
  );

  it("preserves the host-provided OpenClaw tool through the Codex allowlist", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["openclaw"];
    setOpenClawCodingToolsFactoryForTests(() => [
      { ...createRuntimeDynamicTool("openclaw"), catalogMode: "direct-only" },
    ]);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      isHostScopedToolActive: (toolName) => toolName === "openclaw",
      pluginConfig: { codexDynamicToolsExclude: ["openclaw"] },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["openclaw"]);
  });

  it.each([
    { label: "host scope is inactive", hostActive: false, toolsAllow: ["openclaw"] },
    {
      label: "the public allowlist is not exact",
      hostActive: true,
      toolsAllow: ["openclaw", "read"],
    },
  ])("does not bypass Codex excludes when $label", async ({ hostActive, toolsAllow }) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = toolsAllow;
    setOpenClawCodingToolsFactoryForTests(() => [
      { ...createRuntimeDynamicTool("openclaw"), catalogMode: "direct-only" },
    ]);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      isHostScopedToolActive: () => hostActive,
      pluginConfig: { codexDynamicToolsExclude: ["openclaw"] },
    });

    expect(tools).toEqual([]);
  });

  it("shares the computer context epoch with dynamic tool assembly", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const computerContextEpoch = { value: 0 };
    let receivedEpoch: { value: number } | undefined;
    setOpenClawCodingToolsFactoryForTests((options) => {
      receivedEpoch = (options as { computerContextEpoch?: { value: number } })
        .computerContextEpoch;
      return [createRuntimeDynamicTool("message")];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { computerContextEpoch });

    expect(receivedEpoch).toBe(computerContextEpoch);
  });

  it("reports hosted search denied when effective tool policy removes web_search", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setOpenClawCodingToolsFactoryForTests(() => [createRuntimeDynamicTool("message")]);
    let webSearchAllowed = true;

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      onWebSearchPolicyResolved: (allowed) => {
        webSearchAllowed = allowed;
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    expect(webSearchAllowed).toBe(false);
  });

  it("separates persistent search policy from a runtime toolsAllow restriction", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["message"];
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("web_search"),
      createRuntimeDynamicTool("message"),
    ]);
    let persistentWebSearchAllowed = false;
    let webSearchAllowed = true;

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      onPersistentWebSearchPolicyResolved: (allowed) => {
        persistentWebSearchAllowed = allowed;
      },
      onWebSearchPolicyResolved: (allowed) => {
        webSearchAllowed = allowed;
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    expect(persistentWebSearchAllowed).toBe(true);
    expect(webSearchAllowed).toBe(false);
    expect(hoisted.resolveWebSearchToolPolicy).not.toHaveBeenCalled();
  });

  it("keeps persistent search denied when runtime toolsAllow also excludes it", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["message"];
    setOpenClawCodingToolsFactoryForTests(() => [createRuntimeDynamicTool("message")]);
    let persistentWebSearchAllowed = true;
    let webSearchAllowed = true;

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      onPersistentWebSearchPolicyResolved: (allowed) => {
        persistentWebSearchAllowed = allowed;
      },
      onWebSearchPolicyResolved: (allowed) => {
        webSearchAllowed = allowed;
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    expect(persistentWebSearchAllowed).toBe(false);
    expect(webSearchAllowed).toBe(false);
  });

  it("treats sender-scoped web_search denial as transient", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.senderId = "restricted-sender";
    params.config = {
      tools: {
        toolsBySender: {
          "id:restricted-sender": { deny: ["web_search"] },
        },
      },
    } as never;
    setOpenClawCodingToolsFactoryForTests(() => [createRuntimeDynamicTool("message")]);
    let persistentWebSearchAllowed = false;
    let webSearchAllowed = true;

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      onPersistentWebSearchPolicyResolved: (allowed) => {
        persistentWebSearchAllowed = allowed;
      },
      onWebSearchPolicyResolved: (allowed) => {
        webSearchAllowed = allowed;
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    expect(persistentWebSearchAllowed).toBe(true);
    expect(webSearchAllowed).toBe(false);
  });

  it("forwards trusted completion and scheduled authority to policy construction", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.inputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:subagent:codex-child",
      sourceTool: "subagent_announce",
    };
    params.config = {};
    const trustedInternalHandoff: NonNullable<EmbeddedRunAttemptParams["trustedInternalHandoff"]> =
      {
        kind: "subagent-completion",
        sourceSessionKey: "agent:main:subagent:codex-child",
        targetSessionKey: "agent:main:session-1",
        targetSessionId: "session-1",
        provider: "codex",
        model: "gpt-5.4-codex",
      };
    params.trustedInternalHandoff = trustedInternalHandoff;
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "default",
    };
    let receivedOptions: unknown;
    setOpenClawCodingToolsFactoryForTests((options) => {
      receivedOptions = options;
      return [createRuntimeDynamicTool("message")];
    });

    const onPersistentWebSearchPolicyResolved = vi.fn();
    await buildDynamicToolsForTest(params, workspaceDir, {
      onPersistentWebSearchPolicyResolved,
    });

    expect(receivedOptions).toMatchObject({
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff,
      scheduledToolPolicy: params.scheduledToolPolicy,
    });
    expect(hoisted.resolveWebSearchToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        inputProvenance: params.inputProvenance,
        trustedInternalHandoff,
        scheduledToolPolicy: params.scheduledToolPolicy,
      }),
    );
    expect(onPersistentWebSearchPolicyResolved).toHaveBeenCalledWith(false);
  });

  it("keeps persistent search denied when global and sender policy both deny it", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.senderId = "restricted-sender";
    params.config = {
      tools: {
        deny: ["web_search"],
        toolsBySender: {
          "id:restricted-sender": { deny: ["web_search"] },
        },
      },
    } as never;
    setOpenClawCodingToolsFactoryForTests(() => [createRuntimeDynamicTool("message")]);
    let persistentWebSearchAllowed = true;

    await buildDynamicToolsForTest(params, workspaceDir, {
      onPersistentWebSearchPolicyResolved: (allowed) => {
        persistentWebSearchAllowed = allowed;
      },
    });

    expect(persistentWebSearchAllowed).toBe(false);
  });

  it("keeps managed web_search when a managed provider is explicitly selected", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.config = {
      tools: {
        web: {
          search: { provider: "brave" },
        },
      },
    } as never;
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("web_search"),
      createRuntimeDynamicTool("message"),
    ]);

    const tools = await buildDynamicToolsForTest(params, workspaceDir);

    expect(tools.map((tool) => tool.name)).toEqual(["web_search", "message"]);
  });

  it("keeps managed web_search when the active Codex provider lacks hosted search", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("web_search"),
      createRuntimeDynamicTool("message"),
    ]);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeProviderWebSearchSupport: "unsupported",
    });

    expect(tools.map((tool) => tool.name)).toEqual(["web_search", "message"]);
  });

  it("applies additional Codex dynamic tool excludes without exposing Codex-native tools", () => {
    const tools = ["read", "exec", "message", "custom_tool"].map((name) => ({ name }));

    expect(
      filterCodexDynamicTools(tools, {
        codexDynamicToolsExclude: ["custom_tool"],
      }).map((tool) => tool.name),
    ).toEqual(["message"]);
  });

  it("exposes app-server-owned tools directly for forced private QA Codex runtime", () => {
    const tools = [
      "read",
      "write",
      "apply_patch",
      "apply-patch",
      "get_goal",
      "image_generate",
      "message",
    ].map((name) => ({ name }));
    const privateQaCodexEnv = {
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "codex",
    };

    expect(filterCodexDynamicTools(tools, {}, privateQaCodexEnv).map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "image_generate",
      "message",
    ]);
    expect(resolveCodexDynamicToolsLoading({}, privateQaCodexEnv)).toBe("direct");
  });

  it("uses direct dynamic tools for OpenAI nano models without tool_search support", () => {
    const tools = [createRuntimeDynamicTool("message"), createRuntimeDynamicTool("web_search")];
    const toolBridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading: resolveCodexDynamicToolsLoadingForRuntime({}, "openai/gpt-5.4-nano"),
    });

    expect(resolveCodexDynamicToolsLoadingForRuntime({}, "gpt-5.4-nano")).toBe("direct");
    expect(resolveCodexDynamicToolsLoadingForRuntime({}, "gpt-5.5")).toBe("searchable");
    const webSearch = flattenCodexDynamicToolFunctions(toolBridge.specs).find(
      (tool) => tool.name === "web_search",
    );
    expect(webSearch).not.toHaveProperty("deferLoading");
    expect(webSearch).not.toHaveProperty("namespace");
  });

  it("uses direct dynamic tools for remote Codex app-server connections", () => {
    const tools = [createRuntimeDynamicTool("message"), createRuntimeDynamicTool("web_search")];
    const loading = resolveCodexDynamicToolsLoadingForRuntime({}, "openai/gpt-5.5", {
      connectionClass: "remote",
    });
    const toolBridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading,
    });

    expect(resolveCodexDynamicToolsLoadingForRuntime({}, "openai/gpt-5.5")).toBe("searchable");
    expect(loading).toBe("direct");
    expect(toolBridge.specs).toHaveLength(2);
    expect(flattenCodexDynamicToolFunctions(toolBridge.specs).map((tool) => tool.name)).toEqual([
      "message",
      "web_search",
    ]);
    expect(toolBridge.specs.some((tool) => tool.type === "namespace")).toBe(false);
  });

  it("quarantines unreadable tool entries before Codex-specific filtering", async () => {
    const messageTool = createRuntimeDynamicTool("message");
    const sourceTools = new Proxy([messageTool] as RuntimeDynamicToolForTest[], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("fuzzplugin tool entry getter exploded");
        }
        if (property === "1") {
          return messageTool;
        }
        if (property === "length") {
          return 2;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    setOpenClawCodingToolsFactoryForTests(() => sourceTools);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    await expect(buildDynamicToolsForTest(params, workspaceDir)).resolves.toEqual([messageTool]);
  });

  it("quarantines non-object plugin schemas before Codex-specific filtering", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const messageTool = createRuntimeDynamicTool("message");
    const brokenTool = {
      ...createRuntimeDynamicTool("dofbot_move_angles"),
      parameters: { type: "array", items: { type: "number" } },
    };
    setOpenClawCodingToolsFactoryForTests(() => [brokenTool, messageTool]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    await expect(buildDynamicToolsForTest(params, workspaceDir)).resolves.toEqual([messageTool]);
    expect(warn).toHaveBeenCalledWith(
      "codex app-server quarantined 1 unsupported runtime tool schema before dynamic tool registration",
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        diagnostics: [
          {
            index: 0,
            tool: "dofbot_move_angles",
            violations: ['dofbot_move_angles.parameters.type must be "object"'],
            violationCount: 1,
          },
        ],
      }),
    );
  });

  it("limits Codex memory flush runs to managed read and write tools", async () => {
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [
        createRuntimeDynamicTool("read"),
        createRuntimeDynamicTool("write"),
        createRuntimeDynamicTool("exec"),
        createRuntimeDynamicTool("process"),
        createRuntimeDynamicTool("apply_patch"),
        createRuntimeDynamicTool("message"),
        createRuntimeDynamicTool("web_search"),
      ];
    });
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.trigger = "memory";
    params.memoryFlushWritePath = "memory/2026-05-22.md";
    const sandbox = { enabled: true, backendId: "docker" } as never;
    let persistentWebSearchAllowed = false;
    let webSearchAllowed = true;

    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox,
      nativeToolSurfaceEnabled,
      onPersistentWebSearchPolicyResolved: (allowed) => {
        persistentWebSearchAllowed = allowed;
      },
      onWebSearchPolicyResolved: (allowed) => {
        webSearchAllowed = allowed;
      },
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(factoryOptions).toHaveLength(1);
    expect(factoryOptions[0]).toMatchObject({
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-05-22.md",
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(persistentWebSearchAllowed).toBe(true);
    expect(webSearchAllowed).toBe(false);
  });

  it("keeps persistent search disabled during a memory flush when config disables it", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("read"),
      createRuntimeDynamicTool("write"),
      createRuntimeDynamicTool("web_search"),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.trigger = "memory";
    params.memoryFlushWritePath = "memory/2026-05-22.md";
    params.config = { tools: { web: { search: { enabled: false } } } };
    let persistentWebSearchAllowed = true;

    await buildDynamicToolsForTest(params, workspaceDir, {
      onPersistentWebSearchPolicyResolved: (allowed) => {
        persistentWebSearchAllowed = allowed;
      },
    });

    expect(persistentWebSearchAllowed).toBe(false);
  });

  it("maps Podman sandbox network config into Codex external sandbox policy", () => {
    expect(
      resolveCodexExternalSandboxPolicyForOpenClawSandbox({
        enabled: true,
        backendId: "podman",
        docker: { network: "none" },
      } as never),
    ).toEqual({ type: "externalSandbox", networkAccess: "restricted" });

    expect(
      resolveCodexExternalSandboxPolicyForOpenClawSandbox({
        enabled: true,
        backendId: "Podman",
        docker: { network: "bridge" },
      } as never),
    ).toEqual({ type: "externalSandbox", networkAccess: "enabled" });
  });

  it("exposes OpenClaw sandbox shell tools under distinct names for non-Docker sandbox backends", async () => {
    const execTool = expectDefined(
      createOpenClawCodingTools({ workspaceDir: tempDir }).find((tool) => tool.name === "exec"),
      "assembled exec tool",
    );
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("read"),
      createRuntimeDynamicTool("write"),
      createRuntimeDynamicTool("edit"),
      createRuntimeDynamicTool("apply_patch"),
      execTool,
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: { enabled: true, backendId: "ssh" } as never,
      nativeToolSurfaceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "message",
      "sandbox_exec",
      "sandbox_process",
    ]);
    expect(tools.find((tool) => tool.name === "sandbox_exec")?.description).toContain(
      "configured sandbox backend",
    );
    expect(tools.find((tool) => tool.name === "sandbox_exec")?.parameters).not.toHaveProperty(
      "properties.security",
    );
    expect(tools.find((tool) => tool.name === "sandbox_process")?.description).toContain(
      "background shell sessions",
    );
  });

  it("exposes Docker sandbox shell tools when OpenClaw sandboxing disables native Code Mode", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const sandbox = { enabled: true, backendId: "docker" } as never;
    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox);

    const dockerTools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox,
      nativeToolSurfaceEnabled,
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(dockerTools.map((tool) => tool.name)).toEqual([
      "message",
      "sandbox_exec",
      "sandbox_process",
    ]);
  });

  it("keeps a pinned Gateway shell path beside Codex native shell", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "gateway-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.execOverrides = { host: "gateway" };
    await bindProductionCodexHostCapabilities(params);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });

    expect(shellTestToolNames(tools)).toEqual(["message", "gateway_exec", "gateway_process"]);
    const gatewayExec = tools.find((tool) => tool.name === "gateway_exec");
    expect(gatewayExec?.description).toContain("OpenClaw-managed Gateway environment access");
    expect(tools.find((tool) => tool.name === "gateway_process")?.description).toContain(
      "gateway_exec",
    );
    expect(gatewayExec?.parameters).toMatchObject({
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
      },
      required: ["command"],
    });
    expect(gatewayExec?.parameters).not.toHaveProperty("properties.host");
    expect(gatewayExec?.parameters).not.toHaveProperty("properties.security");
    expect(gatewayExec?.parameters).not.toHaveProperty("properties.ask");
    expect(gatewayExec?.parameters).not.toHaveProperty("properties.node");
  });

  it.each([
    {
      label: "an active sandbox",
      options: { sandbox: { enabled: true, backendId: "docker" } as never },
      params: {},
      pluginConfig: {},
    },
    {
      label: "a node-default execution policy",
      options: {},
      params: { execOverrides: { host: "node" } },
      pluginConfig: {},
    },
  ])("does not expose the Gateway shell path under $label", async (testCase) => {
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "gateway-policy-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    Object.assign(params, testCase.params);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: true,
      pluginConfig: testCase.pluginConfig,
      ...testCase.options,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("gateway_exec");
    expect(tools.map((tool) => tool.name)).not.toContain("gateway_process");
  });

  it.each([
    { excluded: "process", expected: ["message", "gateway_exec"] },
    { excluded: "gateway_process", expected: ["message", "gateway_exec"] },
    { excluded: "exec", expected: ["message"] },
    { excluded: "gateway_exec", expected: ["message"] },
  ])("applies the partial Gateway shell exclusion for $excluded", async (testCase) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "gateway-exclusion.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.execOverrides = { host: "gateway" };
    await bindProductionCodexHostCapabilities(params);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: true,
      pluginConfig: { codexDynamicToolsExclude: [testCase.excluded] },
    });

    expect(shellTestToolNames(tools)).toEqual(testCase.expected);
  });

  it.each([false, true])("projects node exec when availability is %s", async (available) => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: String(available),
      isAvailable: () => available,
    });
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("message"),
    ]);
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "eligibility.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    for (const host of ["auto", "node"] as const) {
      params.execOverrides = { host };
      const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params);
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        nativeToolSurfaceEnabled,
      });
      expect(tools.some((tool) => tool.name === "node_exec")).toBe(available);
      expect(nativeToolSurfaceEnabled).toBe(host === "auto");
    }
  });

  it("shares discovery across attempt catalogs but refreshes the next attempt", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [createRuntimeDynamicTool("exec")]);
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "catalog-discovery.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    hoisted.loadNodeExecAvailability.mockClear();
    for (const available of [true, false]) {
      hoisted.loadNodeExecAvailability.mockResolvedValue({
        cacheKey: String(available),
        isAvailable: () => available,
      });
      const nodeExecAvailability = {};
      for (const ignoreRuntimePlan of [false, true]) {
        const tools = await buildDynamicToolsForTest(params, workspaceDir, {
          nodeExecAvailability,
          ignoreRuntimePlan,
        });
        expect(tools.some((tool) => tool.name === "node_exec")).toBe(available);
      }
    }
    expect(hoisted.loadNodeExecAvailability).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation during node discovery without publishing tools", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [createRuntimeDynamicTool("exec")]);
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "cancel-discovery.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const runAbortController = new AbortController();
    const reason = new Error("synthetic attempt cancelled");
    hoisted.loadNodeExecAvailability.mockImplementationOnce(async (signal: AbortSignal) => {
      expect(signal).toBe(runAbortController.signal);
      runAbortController.abort(reason);
      return { cacheKey: "eligible", isAvailable: () => true };
    });
    await expect(
      buildDynamicToolsForTest(params, workspaceDir, { runAbortController }),
    ).rejects.toBe(reason);
  });

  it("exposes pinned node shell tools for node-targeted Codex app-server runs", async () => {
    const execTool = {
      ...createRuntimeDynamicTool("exec"),
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          workdir: { type: "string" },
          host: { type: "string" },
          security: { type: "string" },
          ask: { type: "string" },
          node: { type: "string" },
          background: { type: "boolean" },
          yieldMs: { type: "number" },
          pty: { type: "boolean" },
          elevated: { type: "boolean" },
        },
        required: ["command", "host", "node", "background", "yieldMs", "pty", "elevated"],
        additionalProperties: false,
      },
    };
    vi.mocked(execTool.execute).mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Command still running (session exec-1, pid 123). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
        },
      ],
      details: { status: "running" },
    });
    setOpenClawCodingToolsFactoryForTests(() => [execTool, createRuntimeDynamicTool("message")]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.execOverrides = {
      host: "node",
      node: "mac-mini",
      security: "full",
      ask: "off",
    };

    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled,
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(tools.map((tool) => tool.name)).toEqual(["message", "node_exec"]);
    const nodeExec = tools.find((tool) => tool.name === "node_exec");
    expect(nodeExec?.description).toContain("host=node internally");
    expect(nodeExec?.description).toContain("background follow-up is unavailable");
    expect(nodeExec?.parameters).toEqual({
      type: "object",
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    });
    const result = await nodeExec?.execute(
      "call-1",
      {
        command: "pwd",
        host: "gateway",
        node: "model-selected-node",
        security: "full",
        ask: "off",
        background: true,
        yieldMs: 10,
        pty: true,
        elevated: true,
      },
      undefined,
    );
    expect(execTool.execute).toHaveBeenCalledWith(
      "call-1",
      {
        command: "pwd",
        host: "node",
        node: "mac-mini",
      },
      undefined,
      undefined,
    );
    expect(result?.content).toEqual([
      {
        type: "text",
        text: "Command still running (session exec-1, pid 123). Remote-node background follow-up is unavailable. Wait for the command to complete.",
      },
    ]);

    const runtimePolicySessionFile = path.join(tempDir, "runtime-policy-session.jsonl");
    const runtimePolicyParams = createParams(runtimePolicySessionFile, workspaceDir);
    runtimePolicyParams.disableTools = false;
    runtimePolicyParams.runtimePlan = createCodexRuntimePlanFixture();
    runtimePolicyParams.sessionKey = "agent:main:session-1";
    runtimePolicyParams.sandboxSessionKey = "agent:policy:session-1";
    runtimePolicyParams.sandboxAgentId = "policy";
    runtimePolicyParams.config = {
      agents: {
        entries: {
          main: { tools: { exec: { host: "gateway" } } },
          policy: { tools: { exec: { host: "node", node: "worker-1" } } },
        },
      },
    } as never;
    const runtimePolicyNativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
      runtimePolicyParams,
      undefined,
      { agentId: "policy", runtimeSessionKey: "agent:policy:session-1" },
    );
    const runtimePolicyTools = await buildDynamicToolsForTest(runtimePolicyParams, workspaceDir, {
      sandboxSessionKey: "agent:policy:session-1",
      nativeToolSurfaceEnabled: runtimePolicyNativeToolSurfaceEnabled,
      sessionAgentId: "main",
    });

    expect(runtimePolicyNativeToolSurfaceEnabled).toBe(false);
    expect(runtimePolicyTools.map((tool) => tool.name)).toEqual(["message", "node_exec"]);
  });

  it("does not expose Gateway process sessions as remote-node control in auto host runs", async () => {
    const sessionFile = path.join(tempDir, "auto-node-session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    await bindProductionCodexHostCapabilities(params);
    const resolveExecutionPolicy = vi.spyOn(
      nativeExecutionPolicy,
      "resolveCodexNativeExecutionPolicy",
    );

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null,
      nativeToolSurfaceEnabled: true,
    });

    expect(resolveExecutionPolicy).toHaveBeenCalledOnce();
    expect(resolveExecutionPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxAvailable: false }),
    );
    expect(shellTestToolNames(tools)).toEqual([
      "message",
      "gateway_exec",
      "gateway_process",
      "node_exec",
    ]);
    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading: "direct",
    });
    const nodeList = await bridge.handleToolCall({
      threadId: "auto-thread",
      turnId: "auto-turn",
      tool: "node_process",
      callId: "node-process-list",
      arguments: { action: "list" },
    });
    expect(nodeList.success).toBe(false);
    expect(nodeList.contentItems).toEqual([
      { type: "inputText", text: "Unknown OpenClaw tool: node_process" },
    ]);
    const nodeExec = tools.find((tool) => tool.name === "node_exec");
    expect(nodeExec?.description).toContain(
      "The sole connected node that can execute commands is selected automatically; select by name or id when several can.",
    );
    expect(nodeExec?.parameters).toMatchObject({
      type: "object",
      properties: {
        command: { type: "string" },
        node: { type: "string" },
      },
      required: ["command"],
    });
    expect(nodeExec?.parameters).not.toHaveProperty("properties.host");
    expect(nodeExec?.parameters).not.toHaveProperty("properties.security");
    expect(nodeExec?.parameters).not.toHaveProperty("properties.ask");
    const boundAutoParams = createParams(
      path.join(tempDir, "bound-auto-node-session.jsonl"),
      workspaceDir,
    );
    boundAutoParams.disableTools = false;
    boundAutoParams.runtimePlan = createCodexRuntimePlanFixture();
    boundAutoParams.config = {
      tools: { exec: { host: "auto", node: "bound-mac-mini" } },
    } as never;
    await bindProductionCodexHostCapabilities(boundAutoParams);
    const boundAutoTools = await buildDynamicToolsForTest(boundAutoParams, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });
    const boundNodeExec = boundAutoTools.find((tool) => tool.name === "node_exec");
    expect(boundNodeExec?.parameters).toMatchObject({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    });
    expect(boundNodeExec?.parameters).not.toHaveProperty("properties.node");
    const gatewayParams = createParams(
      path.join(tempDir, "gateway-node-session.jsonl"),
      workspaceDir,
    );
    gatewayParams.disableTools = false;
    gatewayParams.runtimePlan = createCodexRuntimePlanFixture();
    gatewayParams.execOverrides = { host: "gateway" };
    await bindProductionCodexHostCapabilities(gatewayParams);
    const gatewayTools = await buildDynamicToolsForTest(gatewayParams, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });
    expect(shellTestToolNames(gatewayTools)).toEqual([
      "message",
      "gateway_exec",
      "gateway_process",
    ]);

    const allowlistedParams = {
      ...gatewayParams,
      toolsAllow: ["message"],
    } as EmbeddedRunAttemptParams;
    const allowlistedTools = await buildDynamicToolsForTest(allowlistedParams, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });
    expect(shellTestToolNames(allowlistedTools)).toEqual(["message"]);
  });

  it("restores the policy-filtered OpenClaw shell when a finite allowlist disables native Code Mode", async () => {
    const execTool = createRuntimeDynamicTool("exec");
    const processTool = createRuntimeDynamicTool("process");
    const messageTool = createRuntimeDynamicTool("message");
    setOpenClawCodingToolsFactoryForTests(() => [execTool, processTool, messageTool]);
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "restricted-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["exec", "process", "message"];
    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled,
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "process", "message", "node_exec"]);
    expect(
      tools
        .filter((tool) => ["exec", "process", "node_exec"].includes(tool.name))
        .map((tool) => tool.catalogMode),
    ).toEqual(["direct-only", "direct-only", "direct-only"]);

    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading: "direct",
    });
    expect(bridge.specs).toContainEqual({
      type: "namespace",
      name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
      description: "",
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "exec" }),
        expect.objectContaining({ name: "process" }),
        expect.objectContaining({ name: "node_exec" }),
      ]),
    });
    await bridge.handleToolCall({
      threadId: "restricted-thread",
      turnId: "restricted-turn",
      tool: "exec",
      callId: "restricted-exec",
      arguments: { command: "echo restored" },
    });
    expect(execTool.execute).toHaveBeenCalledWith(
      "restricted-exec",
      { command: "echo restored" },
      expect.any(AbortSignal),
      undefined,
    );

    const excludedTools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled,
      pluginConfig: { codexDynamicToolsExclude: ["exec", "process"] },
    });
    expect(excludedTools.map((tool) => tool.name)).toEqual(["message"]);

    const messageOnlyTools = await buildDynamicToolsForTest(
      { ...params, toolsAllow: ["message"] },
      workspaceDir,
      { nativeToolSurfaceEnabled: false },
    );
    expect(messageOnlyTools.map((tool) => tool.name)).toEqual(["message"]);
  });

  it("exposes Docker sandbox shell tools when native Code Mode cannot honor sandbox paths", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const resolveExecutionPolicy = vi.spyOn(
      nativeExecutionPolicy,
      "resolveCodexNativeExecutionPolicy",
    );

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: {
        enabled: true,
        backendId: "docker",
        docker: { binds: ["/tmp/openclaw-data:/data:rw"] },
      } as never,
      nativeToolSurfaceEnabled: false,
    });

    expect(resolveExecutionPolicy).toHaveBeenCalledOnce();
    expect(resolveExecutionPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxAvailable: true }),
    );
    expect(tools.map((tool) => tool.name)).toEqual(["message", "sandbox_exec", "sandbox_process"]);
    expect(tools.map((tool) => tool.catalogMode)).toEqual([
      undefined,
      "direct-only",
      "direct-only",
    ]);
    expect(tools.find((tool) => tool.name === "sandbox_exec")?.description).toContain(
      "Docker container-path bind layout",
    );
  });

  it("exposes node shell but not sandbox shell tools when sandbox routing is disabled", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    const disabledSandboxTools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: { enabled: false, backendId: "ssh" } as never,
      nativeToolSurfaceEnabled: false,
    });

    expect(disabledSandboxTools.map((tool) => tool.name)).toEqual([
      "exec",
      "process",
      "message",
      "node_exec",
    ]);
  });

  it("does not expose sandbox_exec without a matching process follow-up tool", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("message"),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: { enabled: true, backendId: "ssh" } as never,
      nativeToolSurfaceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message"]);
  });

  it("honors Codex dynamic tool excludes for sandbox shell exposure", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    for (const excludedToolName of ["sandbox_exec", "process"]) {
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: { enabled: true, backendId: "ssh" } as never,
        nativeToolSurfaceEnabled: false,
        pluginConfig: { codexDynamicToolsExclude: [excludedToolName] },
      });

      expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    }
  });

  it("passes auth profiles into Codex dynamic tool construction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const authProfileStore = {
      version: 1,
      profiles: {
        "openai:api-key-backup": {
          provider: "openai",
          type: "api_key",
          key: "not-a-real-key",
        },
      },
    } satisfies EmbeddedRunAttemptParams["authProfileStore"];
    params.disableTools = false;
    params.authProfileStore = authProfileStore;
    params.messageActionTurnCapability = "turn-capability-1";
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions).toHaveLength(1);
    expect((factoryOptions[0] as { authProfileStore?: unknown }).authProfileStore).toBe(
      authProfileStore,
    );
    expect(
      (factoryOptions[0] as { messageActionTurnCapability?: unknown }).messageActionTurnCapability,
    ).toBe("turn-capability-1");
  });

  it("materializes an owner-gated prepared plugin tool for Codex", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.senderIsOwner = true;
    params.preparedModelRuntime = { metadataSnapshot: { plugins: [] } } as never;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return options?.senderIsOwner && options.preparedModelRuntime
        ? [createRuntimeDynamicTool("intent")]
        : [];
    });

    const tools = await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(tools.map((tool) => tool.name)).toContain("intent");
    expect(factoryOptions[0]).toMatchObject({
      senderIsOwner: true,
      preparedModelRuntime: params.preparedModelRuntime,
    });
  });

  it("passes native and routable channel targets into Codex dynamic tools", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.chatId = "native-chat-123";
    params.chatType = "direct";
    params.currentChannelId = "D123";
    params.currentMessagingTarget = "user:U123";
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions[0]).toMatchObject({
      chatType: "direct",
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      nativeChannelId: "native-chat-123",
    });
  });

  it("passes the approval reviewer device into Codex dynamic tools", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.approvalReviewerDeviceId = "device-ios-reviewer";
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions[0]).toMatchObject({
      approvalReviewerDeviceId: "device-ios-reviewer",
    });
  });

  it("forwards tool outcome ordering into Codex dynamic tools", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const onToolOutcome = vi.fn();
    const allocateToolOutcomeOrdinal = vi.fn(() => 0);
    params.disableTools = false;
    params.onToolOutcome = onToolOutcome;
    params.allocateToolOutcomeOrdinal = allocateToolOutcomeOrdinal;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions[0]).toMatchObject({
      onToolOutcome,
      allocateToolOutcomeOrdinal,
    });
  });

  it("quarantines exposed Codex memory writes and edits after a network tool", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    {
      let turnTainted = false;
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.config = { tools: { fs: { workspaceOnly: true } } };
      params.disableTools = false;
      params.provider = "openai";
      params.model = createCodexTestModel("openai");
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.senderIsOwner = true;
      params.onToolOutcome = vi.fn((outcome) => {
        if (!outcome.presentationOnly && outcome.resultContentSource === "network") {
          turnTainted = true;
        }
      });
      params.isTurnTainted = () => turnTainted;
      setOpenClawCodingToolsFactoryForTests((options) => {
        const filesystemTools = createOpenClawCodingTools(options).filter((tool) =>
          ["write", "edit"].includes(tool.name),
        );
        const networkTool = wrapToolWithBeforeToolCallHook(
          { ...createRuntimeDynamicTool("web_fetch"), resultContentSource: "network" },
          {
            agentId: "main",
            sessionKey: options?.sessionKey,
            sessionId: options?.sessionId,
            runId: options?.runId,
            onToolOutcome: options?.onToolOutcome,
          },
          { emitDiagnostics: false },
        );
        return [...filesystemTools, networkTool];
      });

      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null as never,
      });
      const tool = (name: string) =>
        expectDefined(
          tools.find((candidate) => candidate.name === name),
          `Codex ${name} dynamic tool`,
        );
      await tool("write").execute("codex-trusted-write", {
        path: "memory/trusted.md",
        content: "owner note\n",
      });
      await tool("web_fetch").execute("codex-network-call", {});
      expect(params.onToolOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "web_fetch", resultContentSource: "network" }),
      );
      expect(params.isTurnTainted()).toBe(true);

      await tool("write").execute("codex-network-write", {
        path: "memory/network.md",
        content: "network note\n",
      });
      await tool("edit").execute("codex-network-edit", {
        path: "memory/trusted.md",
        edits: [{ oldText: "owner note", newText: "network edit" }],
      });

      const freshParams = createParams(path.join(tempDir, "fresh-session.jsonl"), workspaceDir);
      freshParams.config = params.config;
      freshParams.disableTools = false;
      freshParams.provider = "openai";
      freshParams.model = createCodexTestModel("openai");
      freshParams.runtimePlan = createCodexRuntimePlanFixture();
      freshParams.runId = "codex-fresh-run";
      freshParams.senderIsOwner = true;
      freshParams.sessionId = "codex-fresh-session";
      freshParams.sessionKey = "agent:main:codex-fresh-session";
      freshParams.isTurnTainted = () => false;
      const freshTools = await buildDynamicToolsForTest(freshParams, workspaceDir, {
        sandbox: null as never,
      });
      await expectDefined(
        freshTools.find((candidate) => candidate.name === "write"),
        "fresh Codex write tool",
      ).execute("codex-fresh-write", {
        path: "memory/fresh.md",
        content: "fresh owner note\n",
      });

      await expect(
        Promise.all(
          ["memory/trusted.md", "memory/network.md", "memory/fresh.md"].map((relativePath) =>
            readMemoryArtifactProvenance({ workspaceDir, relativePath }),
          ),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ originClass: "untrusted" }),
        expect.objectContaining({ originClass: "untrusted" }),
        expect.objectContaining({ originClass: "agent" }),
      ]);
      await expect(fs.readFile(path.join(workspaceDir, "memory/trusted.md"), "utf8")).resolves.toBe(
        "network edit\n",
      );
      await expect(fs.readFile(path.join(workspaceDir, "memory/network.md"), "utf8")).resolves.toBe(
        "network note\n",
      );
    }
  });

  it("preserves before-tool wrapping through Codex runtime normalization", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    const runtimePlan = createCodexRuntimePlanFixture();
    runtimePlan.tools.normalize = (tools) => tools.map((tool) => ({ ...tool }));
    params.runtimePlan = runtimePlan;
    const wrappedTool = wrapToolWithBeforeToolCallHook(createRuntimeDynamicTool("web_fetch"), {
      agentId: "main",
      sessionId: params.sessionId,
    });
    setOpenClawCodingToolsFactoryForTests(() => [wrappedTool]);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(tools).toHaveLength(1);
    const tool = expectDefined(tools[0], "Codex dynamic tool");
    expect(tool).not.toBe(wrappedTool);
    expect(isToolWrappedWithBeforeToolCallHook(tool)).toBe(true);
  });

  it("builds the durable registered-tool superset without loading a provider runtime", async () => {
    const sessionFile = path.join(tempDir, "session-registered-tools.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-registered-tools");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    const runtimePlan = createCodexRuntimePlanFixture();
    const planNormalize = vi.fn((tools: RuntimeDynamicToolForTest[]) =>
      tools.map((tool) => ({ ...tool, description: `turn:${tool.description}` })),
    );
    runtimePlan.tools.normalize = planNormalize as typeof runtimePlan.tools.normalize;
    params.runtimePlan = runtimePlan;
    const messageTool = createRuntimeDynamicTool("message");
    const heartbeatTool = createRuntimeDynamicTool("heartbeat_respond");
    const invalidTool = {
      ...createRuntimeDynamicTool("invalid_registered_tool"),
      parameters: { type: "array", items: { type: "string" } },
    };
    setOpenClawCodingToolsFactoryForTests((options) => [
      messageTool,
      ...(options?.enableHeartbeatTool === true ? [heartbeatTool, invalidTool] : []),
    ]);

    const turnTools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null as never,
    });
    const registeredTools = await buildDynamicToolsForTest(params, workspaceDir, {
      forceHeartbeatTool: true,
      ignoreDisableMessageTool: true,
      ignoreRuntimePlan: true,
      sandbox: null as never,
    });

    expect(planNormalize).toHaveBeenCalledOnce();
    expect(hoisted.normalizeAgentRuntimeTools).toHaveBeenCalledTimes(2);
    expect(hoisted.normalizeAgentRuntimeTools.mock.calls[0]?.[0]).toMatchObject({
      runtimePlan,
    });
    expect(hoisted.normalizeAgentRuntimeTools.mock.calls[1]?.[0]).toMatchObject({
      allowProviderRuntimePluginLoad: false,
      runtimePlan: undefined,
    });
    expect(hoisted.normalizeAgentRuntimeTools.mock.calls[1]?.[0]).not.toHaveProperty(
      "runtimeHandle",
    );
    expect(turnTools.map((tool) => tool.name)).toEqual(["message"]);
    expect(turnTools[0]?.description).toBe(`turn:${messageTool.description}`);
    expect(registeredTools.map((tool) => tool.name)).toEqual(["message", "heartbeat_respond"]);
    expect(registeredTools.map((tool) => tool.description)).toEqual([
      messageTool.description,
      heartbeatTool.description,
    ]);
    expect(hoisted.resolveWebSearchToolPolicy).not.toHaveBeenCalled();
  });

  it("passes runtime config into Codex exec dynamic tool construction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const runtimeConfig = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            timeoutMs: 1234,
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    params.disableTools = false;
    params.config = runtimeConfig;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    const toolOptions = factoryOptions[0] as {
      config?: unknown;
      exec?: { config?: unknown; mode?: unknown };
    };
    expect(factoryOptions).toHaveLength(1);
    expect(toolOptions.config).toBe(runtimeConfig);
    expect(toolOptions.exec?.config).toBe(runtimeConfig);
    expect(toolOptions.exec?.mode).toBeUndefined();
  });

  it.each([
    { permissionMode: "read-only" as const, execMode: "deny" as const },
    { permissionMode: "guarded" as const, execMode: "ask" as const },
    { permissionMode: "workspace" as const, execMode: "auto" as const },
    { permissionMode: "full" as const, execMode: "full" as const },
  ])(
    "uses the host-prepared $execMode for $permissionMode dynamic exec",
    async ({ permissionMode, execMode }) => {
      const sessionFile = path.join(tempDir, `${permissionMode}-session.jsonl`);
      const workspaceDir = path.join(tempDir, `${permissionMode}-workspace`);
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.execOverrides = { ...params.execOverrides, mode: execMode };
      params.permissionMode = permissionMode;
      params.sessionRoot = workspaceDir;
      params.runtimePlan = createCodexRuntimePlanFixture();
      const factoryOptions: unknown[] = [];
      setOpenClawCodingToolsFactoryForTests((options) => {
        factoryOptions.push(options);
        return [];
      });

      await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

      expect(factoryOptions).toHaveLength(1);
      expect(factoryOptions[0]).toMatchObject({
        exec: { mode: execMode },
        sessionPermissionPolicy: { mode: permissionMode, root: workspaceDir },
      });
    },
  );

  it.each(["ultra", "off"] as const)(
    "passes active %s thinking into shared OpenClaw tool construction",
    async (thinkLevel) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.delegationCapability = "report_only";
      params.thinkLevel = thinkLevel;
      params.runtimePlan = createCodexRuntimePlanFixture();
      const factoryOptions: unknown[] = [];
      setOpenClawCodingToolsFactoryForTests((options) => {
        factoryOptions.push(options);
        return [];
      });

      await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

      expect(factoryOptions).toHaveLength(1);
      expect(factoryOptions[0]).toMatchObject({
        delegationCapability: "report_only",
        requesterThinkingLevel: thinkLevel,
      });
    },
  );

  it("uses the tool auth profile store for Codex dynamic tool construction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const transportAuthProfileStore = {
      version: 1,
      profiles: {
        "openai:work": {
          provider: "openai",
          type: "oauth",
          access: "transport-token",
          refresh: "transport-refresh",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies EmbeddedRunAttemptParams["authProfileStore"];
    const toolAuthProfileStore = {
      version: 1,
      profiles: {
        "openai:work": {
          provider: "openai",
          type: "oauth",
          access: "transport-token",
          refresh: "transport-refresh",
          expires: Date.now() + 60_000,
        },
        "xai:work": {
          provider: "xai",
          type: "oauth",
          access: "xai-token",
          refresh: "xai-refresh",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies EmbeddedRunAttemptParams["authProfileStore"];
    params.disableTools = false;
    params.authProfileStore = transportAuthProfileStore;
    params.toolAuthProfileStore = toolAuthProfileStore;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions).toHaveLength(1);
    expect((factoryOptions[0] as { authProfileStore?: unknown }).authProfileStore).toBe(
      toolAuthProfileStore,
    );
  });

  it("keeps canonical OpenAI Codex runs on OpenAI dynamic tool policy", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.provider = "openai";
    params.modelId = "gpt-5.5";
    params.model = {
      ...createCodexTestModel("openai"),
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
    } as EmbeddedRunAttemptParams["model"];
    params.runtimePlan = {
      ...createCodexRuntimePlanFixture(),
      observability: {
        resolvedRef: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
    };
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions).toHaveLength(1);
    expect((factoryOptions[0] as { modelProvider?: unknown }).modelProvider).toBe("openai");
    expect((factoryOptions[0] as { modelApi?: unknown }).modelApi).toBe("openai-responses");
  });

  it("enables gateway subagent binding for forced private QA Codex runs", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [createRuntimeDynamicTool("sessions_spawn")];
    });

    const tools = await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions).toHaveLength(1);
    const factoryOption = factoryOptions[0] as { allowGatewaySubagentBinding?: unknown };
    expect(factoryOption.allowGatewaySubagentBinding).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
  });

  it.each([
    { label: "unresolved", sandbox: undefined, sandboxAvailable: undefined },
    { label: "resolved absent", sandbox: null, sandboxAvailable: false },
  ])("disables native tools for restricted allowlists with $label sandbox", (testCase) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    const resolveExecutionPolicy = vi.spyOn(
      nativeExecutionPolicy,
      "resolveCodexNativeExecutionPolicy",
    );

    expect(shouldEnableCodexAppServerNativeToolSurface(params, testCase.sandbox)).toBe(true);
    expect(resolveExecutionPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxAvailable: testCase.sandboxAvailable }),
    );

    params.toolsAllow = ["*"];
    expect(shouldEnableCodexAppServerNativeToolSurface(params, testCase.sandbox)).toBe(true);

    params.toolsAllow = [];
    expect(shouldEnableCodexAppServerNativeToolSurface(params, testCase.sandbox)).toBe(false);

    params.toolsAllow = ["message"];
    expect(shouldEnableCodexAppServerNativeToolSurface(params, testCase.sandbox)).toBe(false);
  });

  it("disables Codex native tool surfaces when all tools are disabled", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = true;
    params.toolsAllow = undefined;

    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(false);
  });

  it("disables Codex native tool surfaces when the effective exec target is node", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionParams = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    sessionParams.disableTools = false;
    sessionParams.execOverrides = {
      host: "node",
      node: "mac-mini",
      security: "full",
      ask: "off",
    };

    expect(shouldEnableCodexAppServerNativeToolSurface(sessionParams)).toBe(false);

    sessionParams.toolsAllow = ["*"];
    expect(shouldEnableCodexAppServerNativeToolSurface(sessionParams)).toBe(false);

    const globalParams = createParams(path.join(tempDir, "global-session.jsonl"), workspaceDir);
    globalParams.disableTools = false;
    globalParams.config = { tools: { exec: { host: "node" } } } as never;

    expect(shouldEnableCodexAppServerNativeToolSurface(globalParams)).toBe(false);

    const autoOverrideParams = createParams(
      path.join(tempDir, "auto-override-session.jsonl"),
      workspaceDir,
    );
    autoOverrideParams.disableTools = false;
    autoOverrideParams.config = { tools: { exec: { host: "node" } } } as never;
    autoOverrideParams.execOverrides = { host: "auto" };

    expect(shouldEnableCodexAppServerNativeToolSurface(autoOverrideParams)).toBe(true);

    const agentParams = createParams(path.join(tempDir, "agent-session.jsonl"), workspaceDir);
    agentParams.disableTools = false;
    agentParams.config = {
      agents: {
        entries: { main: { tools: { exec: { host: "node" } } } },
      },
    } as never;

    expect(
      shouldEnableCodexAppServerNativeToolSurface(agentParams, undefined, {
        agentId: "main",
      }),
    ).toBe(false);

    const runtimePolicyParams = createParams(
      path.join(tempDir, "runtime-policy-session.jsonl"),
      workspaceDir,
    );
    runtimePolicyParams.disableTools = false;
    runtimePolicyParams.sessionKey = "agent:main:session-1";
    runtimePolicyParams.sandboxSessionKey = "agent:policy:session-1";
    runtimePolicyParams.config = {
      agents: {
        entries: {
          main: { tools: { exec: { host: "gateway" } } },
          policy: { tools: { exec: { host: "node", node: "worker-1" } } },
        },
      },
    } as never;

    expect(shouldEnableCodexAppServerNativeToolSurface(runtimePolicyParams)).toBe(false);
  });

  it("disables Codex native tool surfaces whenever an OpenClaw sandbox is active", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;

    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, {
        enabled: true,
        backendId: "docker",
        docker: { binds: [] },
      } as never),
    ).toBe(false);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, {
        enabled: true,
        backendId: "docker",
        docker: { binds: ["/tmp/openclaw-data:/data:rw"] },
      } as never),
    ).toBe(false);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, {
        enabled: true,
        backendId: "docker",
        docker: { binds: ["/tmp/openclaw-data:/tmp/openclaw-data:rw"] },
      } as never),
    ).toBe(false);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, {
        enabled: true,
        backendId: "docker",
        docker: {
          binds: [
            "/tmp/openclaw-data:/tmp/openclaw-data:rw",
            "/tmp/openclaw-data/secrets:/tmp/openclaw-data/secrets:ro",
          ],
        },
      } as never),
    ).toBe(false);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, {
        enabled: true,
        backendId: "ssh",
      } as never),
    ).toBe(false);
  });

  it("keeps sandbox exec-server native surfaces behind sandbox tool policy", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    const sandbox = {
      enabled: true,
      backendId: "docker",
      backend: {},
      tools: {
        allow: ["exec", "process", "read", "write", "edit", "apply_patch"],
        deny: [],
      },
    };

    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, sandbox as never, {
        sandboxExecServerEnabled: true,
      }),
    ).toBe(true);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(
        params,
        {
          ...sandbox,
          backendId: "node",
          backend: undefined,
          placementExecutionMode: "remote-exec",
          placementNodeId: "device-1",
        } as never,
        { sandboxExecServerEnabled: true },
      ),
    ).toBe(true);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(
        params,
        {
          ...sandbox,
          tools: { allow: ["exec"], deny: [] },
        } as never,
        { sandboxExecServerEnabled: true },
      ),
    ).toBe(false);

    expect(
      shouldEnableCodexAppServerNativeToolSurface(
        params,
        {
          ...sandbox,
          tools: { allow: [], deny: ["write"] },
        } as never,
        { sandboxExecServerEnabled: true },
      ),
    ).toBe(false);

    params.toolsAllow = ["message"];
    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, sandbox as never, {
        sandboxExecServerEnabled: true,
      }),
    ).toBe(false);
  });

  it.each(["text", "initial audio", "accepted audio steering"])(
    "applies inbound TTS to a final dynamic message for %s",
    async (input) => {
      const workspaceDir = path.join(tempDir, "workspace");
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));
      const synthesize = vi.fn(async (_request: { text: string }) => ({
        audioBuffer: Buffer.from("synthetic speech"),
        fileExtension: ".ogg",
        outputFormat: "ogg",
        voiceCompatible: true,
      }));
      const sendMedia = vi.fn(async (_context: { mediaUrl?: string }) => ({
        channel: "whatsapp",
        messageId: "voice-reply",
      }));
      const sendText = vi.fn(async () => ({ channel: "whatsapp", messageId: "text-reply" }));
      const channel = createOutboundTestPlugin({
        id: "whatsapp",
        capabilities: {
          chatTypes: ["direct"],
          media: true,
          tts: { voice: { synthesisTarget: "voice-note" } },
        },
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) => ({ ok: true, to: to ?? "+12025550123" }),
          sendText,
          sendMedia,
        },
      });
      channel.config.listAccountIds = () => ["default"];
      const registry = createTestRegistry([
        { pluginId: "whatsapp", source: "test", plugin: channel },
      ]);
      registry.speechProviders.push({
        pluginId: "test-speech",
        source: "test",
        provider: { id: "test-speech", label: "Test speech", isConfigured: () => true, synthesize },
      });
      const previousRegistry = getActivePluginRegistry();
      const previousRuntimeConfig = getRuntimeConfigSnapshot();
      const previousSourceConfig = getRuntimeConfigSourceSnapshot();
      setActivePluginRegistry(registry);
      try {
        const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
        params.disableTools = false;
        params.runtimePlan = createCodexRuntimePlanFixture();
        params.config = {
          tts: { auto: "inbound", provider: "test-speech" },
          channels: { whatsapp: { allowFrom: ["*"] } },
        };
        // Match Gateway config ownership so earlier tool construction cannot supply TTS policy.
        setRuntimeConfigSnapshot(params.config, params.config);
        params.messageChannel = "whatsapp";
        params.currentInboundAudio = input === "initial audio";
        const replyOperation = { acceptedSteeredInboundAudio: false };
        params.replyOperation = replyOperation as EmbeddedRunAttemptParams["replyOperation"];
        params.sourceReplyDeliveryMode = "message_tool_only";
        setOpenClawCodingToolsFactoryForTests((options) =>
          createOpenClawCodingTools(options).filter((tool) => tool.name === "message"),
        );
        const tools = await buildDynamicToolsForTest(params, workspaceDir, {
          sandbox: null as never,
        });
        // Accepted steering must reach tools that were already constructed.
        replyOperation.acceptedSteeredInboundAudio = input === "accepted audio steering";
        const bridge = createCodexDynamicToolBridge({
          tools,
          signal: new AbortController().signal,
        });

        const result = await bridge.handleToolCall({
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "voice-final",
          namespace: null,
          tool: "message",
          arguments: {
            action: "send",
            channel: "whatsapp",
            target: "+12025550123",
            message: "Here is the requested spoken reply.",
            final: true,
          },
        });

        const expectsVoice = input !== "text";
        expect(result.success, JSON.stringify(result.contentItems)).toBe(true);
        expect(synthesize).toHaveBeenCalledTimes(expectsVoice ? 1 : 0);
        expect(sendMedia).toHaveBeenCalledTimes(expectsVoice ? 1 : 0);
        if (expectsVoice) {
          expect(sendMedia).toHaveBeenCalledWith(expect.objectContaining({ audioAsVoice: true }));
        } else {
          expect(sendText).toHaveBeenCalledOnce();
        }
      } finally {
        if (previousRuntimeConfig) {
          setRuntimeConfigSnapshot(previousRuntimeConfig, previousSourceConfig ?? undefined);
        } else {
          clearRuntimeConfigSnapshot();
        }
        for (const [sent] of sendMedia.mock.calls) {
          if (sent.mediaUrl) {
            await fs.rm(sent.mediaUrl, { force: true });
          }
        }
        if (previousRegistry) {
          setActivePluginRegistry(previousRegistry);
        } else {
          resetPluginRuntimeStateForTest();
        }
      }
    },
  );

  it("preserves the core final delivery control only on message-tool-only schemas", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setOpenClawCodingToolsFactoryForTests((options) =>
      createOpenClawCodingTools(options).filter((tool) => tool.name === "message"),
    );

    params.sourceReplyDeliveryMode = "message_tool_only";
    const sourceReplyTools = await buildDynamicToolsForTest(params, workspaceDir);
    const sourceReplySchema = sourceReplyTools[0]?.parameters as {
      properties?: Record<string, unknown>;
    };

    expect(sourceReplySchema.properties).toMatchObject({
      final: {
        type: "boolean",
        description:
          "Set false for progress. Set true, or omit, for the completed current-source reply.",
      },
    });

    params.sourceReplyDeliveryMode = "automatic";
    const automaticTools = await buildDynamicToolsForTest(params, workspaceDir);
    const automaticSchema = automaticTools[0]?.parameters as {
      properties?: Record<string, unknown>;
    };

    expect(automaticSchema.properties).not.toHaveProperty("final");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
