import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSandboxShellDynamicToolsIfAvailable,
  buildDynamicTools,
  filterCodexDynamicToolsForAllowlist,
  hasWildcardCodexToolsAllow,
  includeForcedCodexDynamicToolAllow,
  resetOpenClawCodingToolsFactoryForTests,
  resolveOpenClawCodingToolsSessionKeys,
  setOpenClawCodingToolsFactoryForTests,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldForceMessageTool,
} from "./dynamic-tool-build.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoading,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
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
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-tools-"));
  });

  afterEach(async () => {
    resetOpenClawCodingToolsFactoryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
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

    const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox,
      nativeToolSurfaceEnabled,
    });

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(factoryOptions).toHaveLength(1);
    expect(factoryOptions[0]).toMatchObject({
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-05-22.md",
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read", "write"]);
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

  it("keeps OpenClaw shell tools for node-targeted Codex app-server runs", async () => {
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
    params.execOverrides = {
      host: "node",
      node: "mac-mini",
      security: "full",
      ask: "off",
    };

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      nativeToolSurfaceEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message", "exec", "process"]);

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
      nativeToolSurfaceEnabled: false,
      sessionAgentId: "policy",
    });

    expect(runtimePolicyTools.map((tool) => tool.name)).toEqual(["message", "exec", "process"]);
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

  it("does not expose sandbox shell tools when sandbox routing is disabled", async () => {
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

    expect(disabledSandboxTools.map((tool) => tool.name)).toEqual(["message"]);
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
    const tools = ["exec", "sandbox_exec", "sandbox_process", "apply_patch", "read", "message"].map(
      (name) => ({ name }),
    );

    expect(
      filterCodexDynamicToolsForAllowlist(tools, [" BASH ", "apply-patch", "READ"]).map(
        (tool) => tool.name,
      ),
    ).toEqual(["exec", "sandbox_exec", "sandbox_process", "apply_patch", "read"]);
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
        list: [{ id: "main", tools: { exec: { host: "node" } } }],
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
        list: [
          { id: "main", tools: { exec: { host: "gateway" } } },
          { id: "policy", tools: { exec: { host: "node", node: "worker-1" } } },
        ],
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
