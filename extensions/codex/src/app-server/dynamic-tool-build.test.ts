// Codex tests cover dynamic tool build plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  embeddedAgentLog,
  isToolWrappedWithBeforeToolCallHook,
  type EmbeddedRunAttemptParams,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSandboxShellDynamicToolsIfAvailable,
  buildDynamicTools,
  disableCodexPluginThreadConfig,
  filterCodexDynamicToolsForAllowlist,
  hasWildcardCodexToolsAllow,
  includeForcedCodexDynamicToolAllow,
  mapCodexAppServerRemoteWorkspacePath,
  resetOpenClawCodingToolsFactoryForTests,
  resolveCodexAppServerExecutionCwd,
  resolveOpenClawCodingToolsSessionKeys,
  resolveCodexMessageToolProvider,
  setOpenClawCodingToolsFactoryForTests,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldForceMessageTool,
} from "./dynamic-tool-build.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoading,
  resolveCodexDynamicToolsLoadingForModel,
  resolveCodexDynamicToolsLoadingForRuntime,
  shouldUseDirectCodexDynamicToolsForModel,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { createCodexTestModel } from "./test-support.js";

let tempDir: string;

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
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
      additionalProperties: false,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: `${name} done` }],
      details: {},
    })),
  };
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
    nativeToolSurfaceEnabled: true,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    pluginConfig: {},
    onYieldDetected: () => undefined,
    ...options,
  });
}

describe("Codex app-server dynamic tool build", () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-tools-"));
  });

  afterEach(async () => {
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

  it("maps local gateway workspace suffixes to the remote Codex app-server root", () => {
    expect(
      mapCodexAppServerRemoteWorkspacePath({
        value: "/Users/kevinlin/code/openclaw/packages/example",
        localWorkspaceRoot: "/Users/kevinlin/code/openclaw",
        remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
      }),
    ).toBe("/home/oai/openclaw-workspaces/packages/example");
    expect(
      mapCodexAppServerRemoteWorkspacePath({
        value: "/Users/kevinlin/code/openclaw",
        localWorkspaceRoot: "/Users/kevinlin/code/openclaw",
        remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
      }),
    ).toBe("/home/oai/openclaw-workspaces");
  });

  it("fails closed when remote cwd projection cannot stay under the remote workspace root", () => {
    expect(() =>
      mapCodexAppServerRemoteWorkspacePath({
        value: "/Users/kevinlin/code/other",
        localWorkspaceRoot: "/Users/kevinlin/code/openclaw",
        remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
      }),
    ).toThrow("outside OpenClaw workspace root");
  });

  it("maps Windows child paths through remote Codex app-server workspaces", () => {
    expect(
      mapCodexAppServerRemoteWorkspacePath({
        value: "C:\\Users\\kevinlin\\code\\openclaw\\packages\\example",
        localWorkspaceRoot: "C:\\Users\\kevinlin\\code\\openclaw",
        remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
      }),
    ).toBe("/home/oai/openclaw-workspaces/packages/example");
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
      "web_search",
      "message",
      "heartbeat_respond",
      "sessions_spawn",
    ]);
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
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("web_search"),
      createRuntimeDynamicTool("message"),
    ]);
    let webSearchAllowed = false;

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      onWebSearchPolicyResolved: (allowed) => {
        webSearchAllowed = allowed;
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    expect(webSearchAllowed).toBe(true);
  });

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

  it("preserves the host-provided Crestodian tool through the Codex allowlist", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["crestodian"];
    setOpenClawCodingToolsFactoryForTests(() => [
      { ...createRuntimeDynamicTool("crestodian"), catalogMode: "direct-only" },
    ]);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      isHostScopedToolActive: (toolName) => toolName === "crestodian",
      pluginConfig: { codexDynamicToolsExclude: ["crestodian"] },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["crestodian"]);
  });

  it.each([
    { label: "host scope is inactive", hostActive: false, toolsAllow: ["crestodian"] },
    {
      label: "the public allowlist is not exact",
      hostActive: true,
      toolsAllow: ["crestodian", "read"],
    },
  ])("does not bypass Codex excludes when $label", async ({ hostActive, toolsAllow }) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = toolsAllow;
    setOpenClawCodingToolsFactoryForTests(() => [
      { ...createRuntimeDynamicTool("crestodian"), catalogMode: "direct-only" },
    ]);

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      isHostScopedToolActive: () => hostActive,
      pluginConfig: { codexDynamicToolsExclude: ["crestodian"] },
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
    const tools = ["read", "write", "image_generate", "message"].map((name) => ({ name }));
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
      loading: resolveCodexDynamicToolsLoadingForModel({}, "openai/gpt-5.4-nano"),
    });

    expect(shouldUseDirectCodexDynamicToolsForModel("gpt-5.4-nano")).toBe(true);
    expect(resolveCodexDynamicToolsLoadingForModel({}, "gpt-5.4-nano")).toBe("direct");
    expect(resolveCodexDynamicToolsLoadingForModel({}, "gpt-5.5")).toBe("searchable");
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

  it("exposes OpenClaw sandbox shell tools under distinct names for non-Docker sandbox backends", async () => {
    setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("read"),
      createRuntimeDynamicTool("write"),
      createRuntimeDynamicTool("edit"),
      createRuntimeDynamicTool("apply_patch"),
      createRuntimeDynamicTool("exec"),
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

    expect(tools.map((tool) => tool.name)).toEqual(["message", "sandbox_exec", "sandbox_process"]);
    expect(tools.find((tool) => tool.name === "sandbox_exec")?.description).toContain(
      "configured sandbox backend",
    );
    expect(tools.find((tool) => tool.name === "sandbox_process")?.description).toContain(
      "sandbox_exec sessions",
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
        },
        required: ["command", "host", "node"],
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
    const processTool = createRuntimeDynamicTool("process");
    setOpenClawCodingToolsFactoryForTests(() => [
      execTool,
      processTool,
      createRuntimeDynamicTool("message"),
    ]);
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

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message", "node_exec", "node_process"]);
    const nodeExec = tools.find((tool) => tool.name === "node_exec");
    const nodeProcess = tools.find((tool) => tool.name === "node_process");
    expect(nodeExec?.description).toContain("host=node internally");
    expect(nodeProcess?.description).toContain("node_exec sessions");
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
        text: "Command still running (session exec-1, pid 123). Use node_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
      },
    ]);

    const runtimePolicySessionFile = path.join(tempDir, "runtime-policy-session.jsonl");
    const runtimePolicyParams = createParams(runtimePolicySessionFile, workspaceDir);
    runtimePolicyParams.disableTools = false;
    runtimePolicyParams.runtimePlan = createCodexRuntimePlanFixture();
    runtimePolicyParams.sessionKey = "agent:main:session-1";
    runtimePolicyParams.sandboxSessionKey = "agent:policy:session-1";
    runtimePolicyParams.config = {
      agents: {
        list: [
          { id: "main", tools: { exec: { host: "gateway" } } },
          { id: "policy", tools: { exec: { host: "node", node: "worker-1" } } },
        ],
      },
    } as never;
    const runtimePolicyTools = await buildDynamicToolsForTest(runtimePolicyParams, workspaceDir, {
      sandboxSessionKey: "agent:policy:session-1",
      nativeToolSurfaceEnabled: true,
      sessionAgentId: "policy",
    });

    expect(runtimePolicyTools.map((tool) => tool.name)).toEqual([
      "message",
      "node_exec",
      "node_process",
    ]);
  });

  it("exposes selectable node shell tools beside native shell for auto host runs", async () => {
    const execTool = {
      ...createRuntimeDynamicTool("exec"),
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          host: { type: "string" },
          security: { type: "string" },
          ask: { type: "string" },
          node: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    };
    vi.mocked(execTool.execute).mockResolvedValueOnce({
      content: [{ type: "text", text: "arm64" }],
      details: { status: "completed" },
    });
    const processTool = createRuntimeDynamicTool("process");
    setOpenClawCodingToolsFactoryForTests(() => [
      execTool,
      processTool,
      createRuntimeDynamicTool("message"),
    ]);
    const sessionFile = path.join(tempDir, "auto-node-session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message", "node_exec", "node_process"]);
    const nodeExec = tools.find((tool) => tool.name === "node_exec");
    expect(nodeExec?.description).toContain("Select the node by name or id");
    expect(nodeExec?.parameters).toEqual({
      type: "object",
      properties: {
        command: { type: "string" },
        node: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    });
    await nodeExec?.execute(
      "call-auto-node",
      {
        command: "/usr/bin/uname -m",
        node: "mac-mini",
        host: "gateway",
        security: "full",
        ask: "off",
      },
      undefined,
    );
    expect(execTool.execute).toHaveBeenCalledWith(
      "call-auto-node",
      {
        command: "/usr/bin/uname -m",
        node: "mac-mini",
        host: "node",
      },
      undefined,
      undefined,
    );

    vi.mocked(execTool.execute).mockResolvedValueOnce({
      content: [{ type: "text", text: "arm64" }],
      details: { status: "completed" },
    });
    const boundAutoParams = createParams(
      path.join(tempDir, "bound-auto-node-session.jsonl"),
      workspaceDir,
    );
    boundAutoParams.disableTools = false;
    boundAutoParams.runtimePlan = createCodexRuntimePlanFixture();
    boundAutoParams.config = {
      tools: { exec: { host: "auto", node: "bound-mac-mini" } },
    } as never;
    const boundAutoTools = await buildDynamicToolsForTest(boundAutoParams, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });
    const boundNodeExec = boundAutoTools.find((tool) => tool.name === "node_exec");
    expect(boundNodeExec?.parameters).toEqual({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    });
    await boundNodeExec?.execute(
      "call-bound-auto-node",
      { command: "/usr/bin/uname -m", node: "other-node" },
      undefined,
    );
    expect(execTool.execute).toHaveBeenLastCalledWith(
      "call-bound-auto-node",
      {
        command: "/usr/bin/uname -m",
        node: "bound-mac-mini",
        host: "node",
      },
      undefined,
      undefined,
    );

    const gatewayParams = createParams(
      path.join(tempDir, "gateway-node-session.jsonl"),
      workspaceDir,
    );
    gatewayParams.disableTools = false;
    gatewayParams.runtimePlan = createCodexRuntimePlanFixture();
    gatewayParams.execOverrides = { host: "gateway" };
    const gatewayTools = await buildDynamicToolsForTest(gatewayParams, workspaceDir, {
      nativeToolSurfaceEnabled: true,
    });
    expect(gatewayTools.map((tool) => tool.name)).toEqual(["message"]);
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

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: {
        enabled: true,
        backendId: "docker",
        docker: { binds: ["/tmp/openclaw-data:/data:rw"] },
      } as never,
      nativeToolSurfaceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message", "sandbox_exec", "sandbox_process"]);
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
    });

    expect(disabledSandboxTools.map((tool) => tool.name)).toEqual([
      "message",
      "node_exec",
      "node_process",
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
        pluginConfig: { codexDynamicToolsExclude: [excludedToolName] },
      });

      expect(tools.map((tool) => tool.name)).toEqual(["message"]);
    }
  });

  it("points yielded sandbox_exec follow-up guidance at sandbox_process", async () => {
    const execTool = createRuntimeDynamicTool("exec");
    vi.mocked(execTool.execute).mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Command still running (session exec-1, pid 123). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
        },
      ],
      details: { status: "running" },
    });
    const processTool = createRuntimeDynamicTool("process");
    const workspaceDir = path.join(tempDir, "workspace");
    const tools = addSandboxShellDynamicToolsIfAvailable([], [execTool, processTool], {
      params: createParams(path.join(tempDir, "session.jsonl"), workspaceDir),
      sandbox: { enabled: true, backendId: "ssh" },
      nativeToolSurfaceEnabled: false,
      sessionAgentId: "main",
      pluginConfig: {},
    } as never);

    const sandboxExec = tools.find((tool) => tool.name === "sandbox_exec");
    const result = await sandboxExec?.execute("call-1", {}, undefined);

    expect(result?.content).toEqual([
      {
        type: "text",
        text: "Command still running (session exec-1, pid 123). Use sandbox_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
      },
    ]);
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

  it("passes owner identity into Codex dynamic tool construction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.senderIsOwner = true;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setOpenClawCodingToolsFactoryForTests((options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions[0]).toMatchObject({ senderIsOwner: true });
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

  it("normalizes Codex dynamic toolsAllow entries before filtering", () => {
    const tools = [
      "exec",
      "sandbox_exec",
      "sandbox_process",
      "node_exec",
      "node_process",
      "apply_patch",
      "read",
      "message",
    ].map((name) => ({ name }));

    expect(
      filterCodexDynamicToolsForAllowlist(tools, [" BASH ", "apply-patch", "READ"]).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "exec",
      "sandbox_exec",
      "sandbox_process",
      "node_exec",
      "node_process",
      "apply_patch",
      "read",
    ]);
  });

  it("treats an explicit empty Codex dynamic toolsAllow as no tools", () => {
    const tools = ["message", "web_search"].map((name) => ({ name }));

    expect(filterCodexDynamicToolsForAllowlist(tools, [])).toEqual([]);
  });

  it("treats wildcard Codex dynamic toolsAllow as unrestricted", () => {
    const tools = ["message", "web_search"].map((name) => ({ name }));

    expect(filterCodexDynamicToolsForAllowlist(tools, [" * "])).toEqual(tools);
    expect(hasWildcardCodexToolsAllow([" * "])).toBe(true);
  });

  it("disables Codex native tool surfaces for restricted runtime allowlists", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;

    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(true);

    params.toolsAllow = ["*"];
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(true);

    params.toolsAllow = [];
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(false);

    params.toolsAllow = ["message"];
    expect(shouldEnableCodexAppServerNativeToolSurface(params)).toBe(false);
  });

  it("keeps Codex native tool surfaces when the effective exec target is node", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionParams = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    sessionParams.disableTools = false;
    sessionParams.execOverrides = {
      host: "node",
      node: "mac-mini",
      security: "full",
      ask: "off",
    };

    expect(shouldEnableCodexAppServerNativeToolSurface(sessionParams)).toBe(true);

    sessionParams.toolsAllow = ["*"];
    expect(shouldEnableCodexAppServerNativeToolSurface(sessionParams)).toBe(true);

    const globalParams = createParams(path.join(tempDir, "global-session.jsonl"), workspaceDir);
    globalParams.disableTools = false;
    globalParams.config = { tools: { exec: { host: "node" } } } as never;

    expect(shouldEnableCodexAppServerNativeToolSurface(globalParams)).toBe(true);

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
        list: [{ id: "main", tools: { exec: { host: "node" } } }],
      },
    } as never;

    expect(
      shouldEnableCodexAppServerNativeToolSurface(agentParams, undefined, {
        agentId: "main",
      }),
    ).toBe(true);

    const runtimePolicyParams = createParams(
      path.join(tempDir, "runtime-policy-session.jsonl"),
      workspaceDir,
    );
    runtimePolicyParams.disableTools = false;
    runtimePolicyParams.sessionKey = "agent:main:session-1";
    runtimePolicyParams.sandboxSessionKey = "agent:policy:session-1";
    runtimePolicyParams.config = {
      agents: {
        list: [
          { id: "main", tools: { exec: { host: "gateway" } } },
          { id: "policy", tools: { exec: { host: "node", node: "worker-1" } } },
        ],
      },
    } as never;

    expect(shouldEnableCodexAppServerNativeToolSurface(runtimePolicyParams)).toBe(true);
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

  it("forces the message dynamic tool for message-tool-only source replies", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.sourceReplyDeliveryMode = "message_tool_only";

    expect(shouldForceMessageTool(params)).toBe(true);
    expect(includeForcedCodexDynamicToolAllow([], params)).toEqual(["message"]);

    params.disableMessageTool = true;
    expect(shouldForceMessageTool(params)).toBe(false);

    params.disableMessageTool = false;
    params.sourceReplyDeliveryMode = "automatic";
    expect(shouldForceMessageTool(params)).toBe(false);
  });

  it("retains forced message policy for the registered schema override", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.disableMessageTool = true;
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.toolsAllow = [];

    expect(shouldForceMessageTool(params)).toBe(false);
    expect(includeForcedCodexDynamicToolAllow(params.toolsAllow, params)).toEqual([]);

    const registeredPolicyParams = { ...params, disableMessageTool: false };
    expect(shouldForceMessageTool(registeredPolicyParams)).toBe(true);
    expect(includeForcedCodexDynamicToolAllow(params.toolsAllow, registeredPolicyParams)).toEqual([
      "message",
    ]);
  });

  it("passes the live run session key to Codex dynamic tools when sandbox policy uses another key", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.sessionKey = "agent:main:main";

    expect(
      resolveOpenClawCodingToolsSessionKeys(params, "agent:main:telegram:default:direct:1234"),
    ).toEqual({
      sessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: "agent:main:main",
    });

    expect(resolveOpenClawCodingToolsSessionKeys(params, "agent:main:main")).toEqual({
      sessionKey: "agent:main:main",
      runSessionKey: undefined,
    });
  });
});
