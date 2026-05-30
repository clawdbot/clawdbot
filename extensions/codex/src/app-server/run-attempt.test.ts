import fs from "node:fs/promises";
import path from "node:path";
import {
  abortAgentHarnessRun,
  embeddedAgentLog,
  onAgentEvent,
  type AgentEventPayload,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { initializeGlobalHookRunner, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createMockPluginRegistry,
  onTrustedInternalDiagnosticEvent,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "../../prompt-overlay.js";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import {
  buildCodexOpenClawPromptContext,
  buildCodexSystemPromptReport,
  buildCodexWorkspaceBootstrapContext,
  getCodexWorkspaceMemoryToolNames,
  prependCodexOpenClawPromptContext,
} from "./attempt-context.js";
import * as authBridge from "./auth-bridge.js";
import { resolveCodexAppServerEnvApiKeyCacheKey } from "./auth-bridge.js";
import { CodexAppServerRpcError } from "./client.js";
import { readCodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import {
  CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
  createCodexDynamicToolBridge,
} from "./dynamic-tools.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import {
  CodexAppServerEventProjector,
  type CodexAppServerToolTelemetry,
} from "./event-projector.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  createAppServerHarness,
  assistantMessage,
  createParams,
  createCodexRuntimePlanFixture,
  createResumeHarness,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import { testing } from "./run-attempt.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { readCodexAppServerBinding, writeCodexAppServerBinding } from "./session-binding.js";
import * as sharedClientModule from "./shared-client.js";
import { createCodexTestModel } from "./test-support.js";
import { buildTurnStartParams, startOrResumeThread } from "./thread-lifecycle.js";

function flushDiagnosticEvents() {
  return waitForDiagnosticEventsDrained();
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out opening WebSocket"));
    }, 1_000);
    const rejectBeforeOpen = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", rejectBeforeOpen);
    socket.once("close", () => {
      rejectBeforeOpen(new Error("WebSocket closed before open"));
    });
  });
}

function expectResumeRequest(
  requests: Array<{ method: string; params: unknown }>,
  params: Record<string, unknown>,
) {
  const request = requests.find((entry) => entry.method === "thread/resume");
  if (!request) {
    throw new Error("Expected thread/resume request");
  }
  const requestParams = request.params as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(params)) {
    expect(requestParams?.[key]).toEqual(value);
  }
}

async function writeExistingBinding(
  sessionFile: string,
  workspaceDir: string,
  overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
) {
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-existing",
    cwd: workspaceDir,
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    ...overrides,
  });
}

function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    requestTimeoutMs: 60_000,
    turnCompletionIdleTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    codeModeOnly: false,
  };
}

function createMessageDynamicTool(
  description: string,
  actions: string[] = ["send"],
): Parameters<typeof startOrResumeThread>[0]["dynamicTools"][number] {
  return {
    name: "message",
    description,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

function createNamedDynamicTool(
  name: string,
): Parameters<typeof startOrResumeThread>[0]["dynamicTools"][number] {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function setAgentWorkspaceForTest(params: EmbeddedRunAttemptParams, workspaceDir: string): void {
  params.config = {
    ...params.config,
    agents: {
      ...params.config?.agents,
      defaults: {
        ...params.config?.agents?.defaults,
        workspace: workspaceDir,
      },
    },
  } as EmbeddedRunAttemptParams["config"];
}

async function buildDynamicToolsForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
  options: Partial<
    Pick<
      Parameters<typeof testing.buildDynamicTools>[0],
      "forceHeartbeatTool" | "ignoreRuntimePlan"
    >
  > = {},
) {
  const sandboxSessionKey = params.sessionKey;
  if (!sandboxSessionKey) {
    throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
  }
  return testing.buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    effectiveCwd: params.cwd ?? workspaceDir,
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

async function buildCodexTurnContextForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
) {
  const sessionAgentId = "main";
  const agentTools = await buildDynamicToolsForTest(params, workspaceDir);
  const toolBridge = createCodexDynamicToolBridge({
    tools: agentTools,
    signal: new AbortController().signal,
  });
  const dynamicTools = toolBridge.availableSpecs;
  const memoryToolNames = getCodexWorkspaceMemoryToolNames(dynamicTools);
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sessionKey: params.sessionKey ?? params.sessionId,
    sessionAgentId,
    memoryToolNames,
  });
  const threadDeveloperInstructions = [
    testing.buildDeveloperInstructions(params, { dynamicTools }),
    workspaceBootstrapContext.developerInstructions,
  ]
    .filter((section) => section?.trim())
    .join("\n\n");
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
  });
  const codexTurnPromptText = prependCodexOpenClawPromptContext(
    params.prompt,
    openClawPromptContext,
  );
  const turnStartParams = buildTurnStartParams(params, {
    threadId: "thread-1",
    cwd: workspaceDir,
    appServer: resolveCodexAppServerRuntimeOptions({}),
    promptText: codexTurnPromptText,
    turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
    memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
    heartbeatCollaborationInstructions:
      workspaceBootstrapContext.heartbeatCollaborationInstructions,
  });
  const collaborationInstructions =
    turnStartParams.collaborationMode?.settings?.developer_instructions ?? "";
  const inputText = turnStartParams.input?.find((item) => item.type === "text")?.text ?? "";
  const systemPromptReport = buildCodexSystemPromptReport({
    attempt: params,
    sessionKey: params.sessionKey ?? params.sessionId,
    workspaceDir,
    developerInstructions: [threadDeveloperInstructions, collaborationInstructions].join("\n\n"),
    workspaceBootstrapContext,
    skillsPrompt: "",
    tools: dynamicTools,
  });
  return {
    collaborationInstructions,
    inputText,
    systemPromptReport,
    threadDeveloperInstructions,
  };
}

function createCodexToolBridgeForTest(
  params: EmbeddedRunAttemptParams,
  tools: RuntimeDynamicToolForTest[],
  registeredTools: RuntimeDynamicToolForTest[] = tools,
) {
  const signal = new AbortController().signal;
  return createCodexDynamicToolBridge({
    tools,
    registeredTools,
    signal,
    directToolNames: testing.shouldForceMessageTool(params) ? ["message"] : [],
  });
}

async function startThreadWithDisabledNativeSurfaceForTest(
  params: EmbeddedRunAttemptParams,
  options: {
    pluginConfig?: Record<string, unknown>;
    developerInstructions?: string;
  } = {},
) {
  const workspaceDir = params.workspaceDir;
  if (!workspaceDir) {
    throw new Error("createParams must provide a workspaceDir for Codex thread tests.");
  }
  const sandboxSessionKey = params.sessionKey;
  if (!sandboxSessionKey) {
    throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
  }
  const nativeToolSurfaceEnabled = testing.shouldEnableCodexAppServerNativeToolSurface(params);
  const dynamicTools = await testing.buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sandboxSessionKey,
    sandbox: { enabled: false, backendId: "docker" } as never,
    nativeToolSurfaceEnabled,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    pluginConfig: options.pluginConfig ?? {},
    onYieldDetected: () => undefined,
  });
  const request = vi.fn(async (method: string, _requestParams?: unknown) => {
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "app/list") {
      throw new Error("app/list should not run when runtime toolsAllow is empty.");
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const pluginConfig = {
    ...options.pluginConfig,
    codexPlugins: {
      ...(options.pluginConfig?.codexPlugins as Record<string, unknown> | undefined),
      enabled: false,
    },
  };

  await startOrResumeThread({
    client: { request } as never,
    params,
    cwd: workspaceDir,
    dynamicTools: dynamicTools as never,
    appServer: createThreadLifecycleAppServerOptions(),
    developerInstructions: options.developerInstructions,
    nativeCodeModeEnabled: nativeToolSurfaceEnabled,
    nativeCodeModeOnlyEnabled: false,
    userMcpServersEnabled: false,
    environmentSelection: [],
    pluginThreadConfig: {
      enabled: true,
      build: () =>
        buildCodexPluginThreadConfig({
          pluginConfig,
          request: request as never,
          appCacheKey: "test-app-cache-key",
        }),
    },
  });

  return { request, nativeToolSurfaceEnabled };
}

function filterAllowedRuntimeToolNamesForTest(
  params: EmbeddedRunAttemptParams,
  tools: RuntimeDynamicToolForTest[],
) {
  const toolsAllow = testing.includeForcedCodexDynamicToolAllow(params.toolsAllow, params);
  return testing.filterCodexDynamicToolsForAllowlist(tools, toolsAllow).map((tool) => tool.name);
}

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

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

function buildEmptyCodexToolTelemetry(): CodexAppServerToolTelemetry {
  return {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
  };
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt", () => {
  it("recreates cached Codex workspace directories after cleanup removes them", async () => {
    const workspaceDir = path.join(tempDir, "cached-workspace");

    await testing.ensureCodexWorkspaceDirOnceForTests(workspaceDir);
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await testing.ensureCodexWorkspaceDirOnceForTests(workspaceDir);

    expect((await fs.stat(workspaceDir)).isDirectory()).toBe(true);
  });

  it("starts active OpenClaw sandbox threads with Codex native execution disabled", async () => {
    testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("exec"),
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const sandbox = {
      enabled: true,
      backendId: "codex-test-sandbox",
      workspaceAccess: "rw",
    } as never;
    const nativeToolSurfaceEnabled = testing.shouldEnableCodexAppServerNativeToolSurface(
      params,
      sandbox,
    );
    const dynamicTools = await testing.buildDynamicTools({
      params,
      resolvedWorkspace: workspaceDir,
      effectiveWorkspace: workspaceDir,
      sandboxSessionKey: params.sessionKey!,
      sandbox,
      nativeToolSurfaceEnabled,
      runAbortController: new AbortController(),
      sessionAgentId: "main",
      pluginConfig: {},
      onYieldDetected: () => undefined,
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: dynamicTools as never,
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: nativeToolSurfaceEnabled,
      nativeCodeModeOnlyEnabled: false,
      userMcpServersEnabled: nativeToolSurfaceEnabled,
      environmentSelection: [],
    });

    const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startRequest?.[1] as Record<string, unknown> | undefined;
    const startConfig = startParams?.config as Record<string, unknown> | undefined;
    const startDynamicTools = startParams?.dynamicTools as Array<{ name: string }> | undefined;
    expect(startConfig?.["features.code_mode"]).toBe(false);
    expect(startConfig?.["features.code_mode_only"]).toBe(false);
    expect(startParams?.environments).toEqual([]);
    expect(startDynamicTools?.map((tool) => tool.name)).toEqual([
      "message",
      "sandbox_exec",
      "sandbox_process",
    ]);
  });

  it("routes native Codex execution through an OpenClaw sandbox exec-server when opted in", async () => {
    const appServer = {
      ...createThreadLifecycleAppServerOptions(),
      sandbox: "danger-full-access" as const,
    };
    const sandbox = {
      ...createSandboxContext({
        runShellCommand: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        }),
      }),
      backendId: "codex-test-sandbox",
      runtimeId: `codex-test-runtime-${path.basename(tempDir)}`,
      runtimeLabel: "Codex Test Sandbox",
    };
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "environment/add") {
        return {};
      }
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getServerVersion: () => "0.132.0",
      request,
    };
    try {
      testing.setOpenClawCodingToolsFactoryForTests(() => [
        createRuntimeDynamicTool("exec"),
        createRuntimeDynamicTool("process"),
        createRuntimeDynamicTool("message"),
      ]);
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "codex-test-sandbox",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      } as never;
      const nativeToolSurfaceEnabled = testing.shouldEnableCodexAppServerNativeToolSurface(
        params,
        sandbox as never,
        { sandboxExecServerEnabled: true },
      );
      const dynamicTools = await testing.buildDynamicTools({
        params,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: "/workspace",
        sandboxSessionKey: params.sessionKey!,
        sandbox: sandbox as never,
        nativeToolSurfaceEnabled,
        runAbortController: new AbortController(),
        sessionAgentId: "main",
        pluginConfig: {
          appServer: {
            mode: "yolo",
            experimental: { sandboxExecServer: true },
          },
        },
        onYieldDetected: () => undefined,
      });
      const environment = await ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox: sandbox as never,
        appServerStartOptions: appServer.start,
      });
      if (!environment) {
        throw new Error("expected sandbox exec-server environment");
      }
      const environmentSelection = [environment];

      await startOrResumeThread({
        client: client as never,
        params,
        cwd: environment.cwd,
        dynamicTools: dynamicTools as never,
        appServer,
        nativeCodeModeEnabled: nativeToolSurfaceEnabled,
        nativeCodeModeOnlyEnabled: false,
        userMcpServersEnabled: nativeToolSurfaceEnabled,
        environmentSelection,
      });

      const turnParams = buildTurnStartParams(params, {
        threadId: "thread-1",
        cwd: environment.cwd,
        appServer,
        sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
        environmentSelection,
      });

      const environmentAdd = request.mock.calls.find(([method]) => method === "environment/add");
      const environmentAddParams = environmentAdd?.[1] as
        | { environmentId?: string; execServerUrl?: string }
        | undefined;
      const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
      const startParams = startRequest?.[1] as
        | {
            cwd?: string;
            dynamicTools?: Array<{ name: string }>;
            environments?: Array<{ environmentId?: string; cwd?: string }>;
            sandbox?: string;
            config?: {
              "features.code_mode"?: boolean;
              "features.code_mode_only"?: boolean;
              "features.apply_patch_streaming_events"?: boolean;
            };
          }
        | undefined;

      expect(nativeToolSurfaceEnabled).toBe(true);
      expect(environmentAddParams?.environmentId).toMatch(/^openclaw-sandbox-/);
      expect(environmentAddParams?.execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      expect(startParams?.cwd).toBe("/workspace");
      expect(startParams?.config?.["features.code_mode"]).toBe(true);
      expect(startParams?.config?.["features.code_mode_only"]).toBe(false);
      expect(startParams?.config?.["features.apply_patch_streaming_events"]).toBe(true);
      expect(startParams?.dynamicTools?.map((tool) => tool.name)).toEqual(["message"]);
      expect(startParams?.environments).toEqual([
        { environmentId: environmentAddParams?.environmentId, cwd: "/workspace" },
      ]);
      expect(startParams?.sandbox).toBe("danger-full-access");
      expect(turnParams.sandboxPolicy).toEqual({
        type: "externalSandbox",
        networkAccess: "enabled",
      });
      expect(turnParams.cwd).toBe("/workspace");
      expect(turnParams.environments).toEqual(startParams?.environments);
    } finally {
      await releaseCodexSandboxExecServerEnvironment(sandbox as never);
    }
  });

  it("closes the sandbox exec-server release path used by turn/start failure cleanup", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const appServer = {
      ...createThreadLifecycleAppServerOptions(),
      sandbox: "danger-full-access",
    };
    const sandbox = createSandboxContext({
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    });
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "environment/add") {
        return {};
      }
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw new Error("turn start failed");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getServerVersion: () => "0.132.0",
      request,
    };
    try {
      const environment = await ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
        appServerStartOptions: appServer.start,
      });
      if (!environment) {
        throw new Error("expected sandbox exec-server environment");
      }
      const environmentSelection = [environment];

      const thread = await startOrResumeThread({
        client: client as never,
        params,
        cwd: environment.cwd,
        dynamicTools: [createNamedDynamicTool("message")] as never,
        appServer: appServer as never,
        nativeCodeModeEnabled: true,
        nativeCodeModeOnlyEnabled: false,
        userMcpServersEnabled: false,
        environmentSelection,
      });

      const turnParams = buildTurnStartParams(params, {
        threadId: thread.threadId,
        cwd: environment.cwd,
        appServer: appServer as never,
        sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
        environmentSelection,
      });

      await expect(
        client.request("turn/start", turnParams).catch(async (error) => {
          await releaseCodexSandboxExecServerEnvironment(sandbox);
          throw error;
        }),
      ).rejects.toThrow("turn start failed");

      const environmentAdd = request.mock.calls.find(([method]) => method === "environment/add");
      const environmentAddParams = environmentAdd?.[1] as { execServerUrl?: string } | undefined;
      expect(environmentAddParams?.execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      await expect(openSocket(environmentAddParams!.execServerUrl!)).rejects.toThrow();
    } finally {
      await releaseCodexSandboxExecServerEnvironment(sandbox);
    }
  });

  it("closes the sandbox exec-server release path used by context-engine retry setup cleanup", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const appServer = {
      ...createThreadLifecycleAppServerOptions(),
      sandbox: "danger-full-access",
    };
    const sandbox = createSandboxContext({
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    });
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "environment/add") {
        return {};
      }
      if (method === "thread/start") {
        throw new Error("retry setup failed");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getServerVersion: () => "0.132.0",
      request,
    };
    try {
      const environment = await ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
        appServerStartOptions: appServer.start,
      });
      if (!environment) {
        throw new Error("expected sandbox exec-server environment");
      }
      const environmentSelection = [environment];

      await expect(
        startOrResumeThread({
          client: client as never,
          params,
          cwd: environment.cwd,
          dynamicTools: [createNamedDynamicTool("message")] as never,
          appServer: appServer as never,
          nativeCodeModeEnabled: true,
          nativeCodeModeOnlyEnabled: false,
          userMcpServersEnabled: false,
          environmentSelection,
        }).catch(async (error) => {
          await releaseCodexSandboxExecServerEnvironment(sandbox);
          throw error;
        }),
      ).rejects.toThrow("retry setup failed");

      const environmentAdd = request.mock.calls.find(([method]) => method === "environment/add");
      const environmentAddParams = environmentAdd?.[1] as { execServerUrl?: string } | undefined;
      expect(environmentAddParams?.execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      await expect(openSocket(environmentAddParams!.execServerUrl!)).rejects.toThrow();
    } finally {
      await releaseCodexSandboxExecServerEnvironment(sandbox);
    }
  });

  it("closes the sandbox exec-server release path used by startup timeout cleanup", async () => {
    const appServer = {
      ...createThreadLifecycleAppServerOptions(),
      sandbox: "danger-full-access",
    };
    const sandbox = createSandboxContext({
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    });
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "environment/add") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getServerVersion: () => "0.132.0",
      request,
    };
    try {
      const environment = await ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
        appServerStartOptions: appServer.start,
      });
      if (!environment) {
        throw new Error("expected sandbox exec-server environment");
      }

      await expect(
        testing.withCodexStartupTimeout({
          timeoutMs: 5,
          signal: new AbortController().signal,
          onTimeout: async () => {
            await releaseCodexSandboxExecServerEnvironment(sandbox);
          },
          operation: async () => new Promise<never>(() => undefined),
        }),
      ).rejects.toThrow("codex app-server startup timed out");

      const environmentAdd = request.mock.calls.find(([method]) => method === "environment/add");
      const environmentAddParams = environmentAdd?.[1] as { execServerUrl?: string } | undefined;
      expect(environmentAddParams?.execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      await expect(openSocket(environmentAddParams!.execServerUrl!)).rejects.toThrow();
    } finally {
      await releaseCodexSandboxExecServerEnvironment(sandbox);
    }
  });

  it("starts Codex threads without duplicate OpenClaw workspace tools by default", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const dynamicTools = testing.filterCodexDynamicTools(
      [
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
      ].map(createNamedDynamicTool),
      {},
    );

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools,
      appServer,
    });

    const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
    const dynamicToolNames = (
      (startRequest?.[1] as { dynamicTools?: Array<{ name: string }> } | undefined)?.dynamicTools ??
      []
    ).map((tool) => tool.name);

    expect(dynamicToolNames).toContain("message");
    expect(dynamicToolNames).toContain("web_search");
    for (const toolName of [
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
    ]) {
      expect(dynamicToolNames).not.toContain(toolName);
    }
  });

  it("passes MCP server config through to Codex thread/start", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      config: {
        mcp_servers: {
          search: {
            url: "https://mcp.example.com/mcp",
          },
        },
      },
      mcpServersFingerprint: "mcp-v1",
      mcpServersFingerprintEvaluated: true,
    });

    const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
    expect((startRequest?.[1] as { config?: unknown } | undefined)?.config).toMatchObject({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
        },
      },
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.mcpServersFingerprint).toBe("mcp-v1");
  });

  it("starts a new Codex thread when the MCP server fingerprint changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "old-thread",
      cwd: workspaceDir,
      dynamicToolsFingerprint: JSON.stringify([]),
      mcpServersFingerprint: "mcp-v1",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("new-thread");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      mcpServersFingerprint: "mcp-v2",
      mcpServersFingerprintEvaluated: true,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(binding.threadId).toBe("new-thread");
    expect(binding.mcpServersFingerprint).toBe("mcp-v2");
  });

  it("uses task cwd for Codex app-server requests while keeping bootstrap workspace separate", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const taskCwd = path.join(tempDir, "task-repo");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(taskCwd, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace bootstrap", "utf8");
    await fs.writeFile(path.join(taskCwd, "task-marker.txt"), "task marker", "utf8");
    const appServer = createThreadLifecycleAppServerOptions();
    const params = createParams(sessionFile, workspaceDir);
    const requests: Array<{ method: string; params: unknown }> = [];

    await startOrResumeThread({
      client: {
        getServerVersion: () => "0.132.0",
        request: async (method: string, requestParams?: unknown) => {
          requests.push({ method, params: requestParams });
          if (method === "thread/start") {
            return threadStartResult();
          }
          return {};
        },
      } as never,
      params,
      cwd: taskCwd,
      dynamicTools: [],
      appServer,
      developerInstructions: "workspace bootstrap",
    });
    const threadStart = requests.find((request) => request.method === "thread/start");
    expect((threadStart?.params as { cwd?: string } | undefined)?.cwd).toBe(taskCwd);

    const turnStart = buildTurnStartParams(params, {
      threadId: "thread-1",
      cwd: taskCwd,
      appServer,
    });
    expect(turnStart.cwd).toBe(taskCwd);
  });

  it("starts a no-MCP Codex thread when MCP config is evaluated empty", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "old-thread",
      cwd: workspaceDir,
      dynamicToolsFingerprint: JSON.stringify([]),
      mcpServersFingerprint: "mcp-v1",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("new-thread");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      mcpServersFingerprintEvaluated: true,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(binding.threadId).toBe("new-thread");
    expect(binding.mcpServersFingerprint).toBeUndefined();
    expect((await readCodexAppServerBinding(sessionFile))?.mcpServersFingerprint).toBeUndefined();
  });

  it("scopes Codex developer reply instructions to message-tool-only delivery", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.sourceReplyDeliveryMode = "message_tool_only";

    expect(
      testing.buildDeveloperInstructions(params, {
        dynamicTools: [createMessageDynamicTool("Message test tool")],
      }),
    ).toContain("Visible source replies are not automatically delivered for this run.");

    const withoutMessageToolInstructions = testing.buildDeveloperInstructions(params, {
      dynamicTools: [],
    });
    expect(withoutMessageToolInstructions).toContain(
      "reply normally in your final assistant message",
    );
    expect(withoutMessageToolInstructions).not.toContain("message(action=send)");
    expect(withoutMessageToolInstructions).not.toContain("Use `message`");

    params.sourceReplyDeliveryMode = "automatic";
    const automaticInstructions = testing.buildDeveloperInstructions(params);
    expect(automaticInstructions).toContain("reply normally in your final assistant message");
    expect(automaticInstructions).not.toContain("message(action=send)");
  });

  it("includes Codex app-server scoped plugin command guidance in developer instructions", () => {
    registerPluginCommand("demo-plugin", {
      name: "codex_demo",
      description: "Codex demo command",
      agentPromptGuidance: [
        "Legacy global command guidance.",
        {
          text: "Codex app-server command guidance.",
          surfaces: ["codex_app_server"],
        },
        {
          text: "Unscoped structured command guidance.",
        },
        {
          text: "OpenClaw main command guidance.",
          surfaces: ["openclaw_main"],
        },
      ],
      handler: async () => ({ text: "ok" }),
    });
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);

    const instructions = testing.buildDeveloperInstructions(params);

    expect(instructions).toContain("Codex app-server command guidance.");
    expect(instructions).not.toContain("Legacy global command guidance.");
    expect(instructions).not.toContain("Unscoped structured command guidance.");
    expect(instructions).not.toContain("OpenClaw main command guidance.");
  });

  it("passes OpenClaw skills as turn collaboration developer instructions", async () => {
    const llmInput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "llm_input", handler: llmInput }]),
    );
    vi.stubEnv("OPENCLAW_TRAJECTORY", "1");
    vi.stubEnv("OPENCLAW_TRAJECTORY_DIR", path.join(tempDir, "trajectory"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.skillsSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [],
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as { developerInstructions?: string };
    expect(threadStartParams.developerInstructions).not.toContain("<available_skills>");

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      input?: Array<{ text?: string }>;
      collaborationMode?: {
        settings?: {
          developer_instructions?: string | null;
        };
      };
    };
    const collaborationInstructions =
      turnStartParams.collaborationMode?.settings?.developer_instructions ?? "";
    expect(collaborationInstructions).toContain("## OpenClaw Skills");
    expect(collaborationInstructions).toContain("<available_skills>");
    const inputText = turnStartParams.input?.[0]?.text ?? "";
    expect(inputText).not.toContain("## OpenClaw Skills");
    expect(inputText).not.toContain("<available_skills>");
    expect(inputText).toBe("hello");
    const [llmInputPayload] = mockCall(llmInput, "llm_input") as [{ prompt?: string }, unknown];
    expect(llmInputPayload.prompt).toBe(inputText);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempDir, "trajectory", "session-1.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { data?: { prompt?: string; systemPrompt?: string }; type?: string },
      );
    const compiledContext = trajectoryEvents.find((event) => event.type === "context.compiled");
    expect(compiledContext?.data?.prompt).toBe(inputText);
    expect(compiledContext?.data?.systemPrompt).toContain("## OpenClaw Skills");
    expect(trajectoryEvents.find((event) => event.type === "prompt.submitted")?.data?.prompt).toBe(
      inputText,
    );
    expect(result.systemPromptReport?.skills.promptChars).toBe(params.skillsSnapshot.prompt.length);
    expect(result.systemPromptReport?.skills.entries).toEqual([
      { name: "demo", blockChars: "<skill><name>demo</name></skill>".length },
    ]);
  });

  it("keeps leading delivery hints out of the Codex current user request", async () => {
    const sessionFile = path.join(tempDir, "session-delivery-hint.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-delivery-hint");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "Delivery: to send a message, use the `message` tool.\n\nhello";
    params.skillsSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [],
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      input?: Array<{ text?: string }>;
    };
    const inputText = turnStartParams.input?.[0]?.text ?? "";
    expect(inputText).toContain("OpenClaw delivery metadata:");
    expect(inputText).toContain(
      "This delivery metadata is runtime routing guidance, not the user's request.",
    );
    expect(inputText).toContain("Delivery: to send a message, use the `message` tool.");
    expect(inputText).toContain("Current user request:\nhello");
    expect(inputText).not.toContain("Current user request:\nDelivery:");
  });

  it("mirrors the Codex prompt into the transcript when the turn starts", async () => {
    const sessionFile = path.join(tempDir, "session-early-prompt.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-early-prompt");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "external channel prompt";
    const onUserMessagePersisted = vi.fn();
    params.onUserMessagePersisted = onUserMessagePersisted;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await vi.waitFor(async () => {
      const raw = await fs.readFile(sessionFile, "utf8");
      expect(raw).toContain('"role":"user"');
      expect(raw).toContain('"content":"external channel prompt"');
      expect(raw).toContain('"idempotencyKey":"codex-app-server:thread-1:turn-1:prompt"');
    });
    await vi.waitFor(() => {
      expect(onUserMessagePersisted).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "user",
          content: "external channel prompt",
          idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
        }),
      );
    });

    const rawBeforeCompletion = await fs.readFile(sessionFile, "utf8");
    expect(rawBeforeCompletion).not.toContain('"role":"assistant"');

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const rawAfterCompletion = await fs.readFile(sessionFile, "utf8");
    expect(rawAfterCompletion.match(/"role":"user"/gu)).toHaveLength(1);
    expect(onUserMessagePersisted).toHaveBeenCalledTimes(1);
  });

  it("does not mirror the Codex prompt early when user message persistence is suppressed", async () => {
    const sessionFile = path.join(tempDir, "session-suppressed-early-prompt.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-suppressed-early-prompt");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "already persisted prompt";
    params.suppressNextUserMessagePersistence = true;
    const readTranscript = async () =>
      fs.readFile(sessionFile, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return "";
        }
        throw error;
      });

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await expect(
      vi.waitFor(
        async () => {
          const raw = await readTranscript();
          expect(raw).toContain("already persisted prompt");
        },
        { interval: 1, timeout: 100 },
      ),
    ).rejects.toThrow();
    const rawBeforeCompletion = await readTranscript();
    expect(rawBeforeCompletion).not.toContain("already persisted prompt");
    expect(rawBeforeCompletion).not.toContain(
      '"idempotencyKey":"codex-app-server:thread-1:turn-1:prompt"',
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const rawAfterCompletion = await readTranscript();
    expect(rawAfterCompletion).not.toContain("already persisted prompt");
    expect(rawAfterCompletion).not.toContain(
      '"idempotencyKey":"codex-app-server:thread-1:turn-1:prompt"',
    );
  });

  it("accepts turn completions scoped by nested turn thread id", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "parent-thread",
        turn: {
          id: "turn-1",
          threadId: "thread-1",
          status: "completed",
          items: [{ id: "agent-1", type: "agentMessage", text: "Nested done." }],
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    });

    const result = await run;

    expect(result.promptError).toBeNull();
    expect(result.assistantTexts).toEqual(["Nested done."]);
  });

  it("keeps forced message dynamic tool when toolsAllow omits it", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.toolsAllow = ["music_generate"];

    const dynamicToolNames = filterAllowedRuntimeToolNamesForTest(params, [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("music_generate"),
    ]);

    expect(dynamicToolNames).toContain("message");
    expect(dynamicToolNames).toContain("music_generate");
  });

  it("keeps forced message dynamic tool when toolsAllow is empty", () => {
    const tools = [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("music_generate"),
      createRuntimeDynamicTool("heartbeat_respond"),
    ];
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.toolsAllow = [];

    const dynamicToolNames = filterAllowedRuntimeToolNamesForTest(params, tools);

    expect(dynamicToolNames).toEqual(["message"]);
  });

  it("keeps forced heartbeat registration inside narrow toolsAllow policy", () => {
    const tools = [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("heartbeat_respond"),
    ];
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["message"];

    const dynamicToolNames = filterAllowedRuntimeToolNamesForTest(params, tools);

    expect(dynamicToolNames).toEqual(["message"]);
  });

  it("keeps searchable OpenClaw dynamic tools when code-mode-only is enabled", () => {
    const tools = [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("web_search"),
      createRuntimeDynamicTool("heartbeat_respond"),
      createRuntimeDynamicTool("sessions_spawn"),
      createRuntimeDynamicTool("sessions_yield"),
    ];
    const toolBridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      directToolNames: ["message"],
    });

    const message = toolBridge.specs.find((tool) => tool.name === "message");
    const webSearch = toolBridge.specs.find((tool) => tool.name === "web_search");
    const heartbeat = toolBridge.specs.find((tool) => tool.name === "heartbeat_respond");
    const sessionsSpawn = toolBridge.specs.find((tool) => tool.name === "sessions_spawn");
    const sessionsYield = toolBridge.specs.find((tool) => tool.name === "sessions_yield");

    expect(message).not.toHaveProperty("namespace");
    expect(message).not.toHaveProperty("deferLoading");
    expect(webSearch?.namespace).toBe(CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE);
    expect(webSearch?.deferLoading).toBe(true);
    expect(heartbeat?.namespace).toBe(CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE);
    expect(heartbeat?.deferLoading).toBe(true);
    expect(sessionsSpawn?.namespace).toBe(CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE);
    expect(sessionsSpawn?.deferLoading).toBe(true);
    expect(sessionsYield).not.toHaveProperty("namespace");
    expect(sessionsYield).not.toHaveProperty("deferLoading");
  });

  it("registers heartbeat response durably without advertising it on normal turns", async () => {
    testing.setOpenClawCodingToolsFactoryForTests((options) => [
      createRuntimeDynamicTool("message"),
      ...(options?.enableHeartbeatTool === true
        ? [createRuntimeDynamicTool("heartbeat_respond")]
        : []),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const createRunParams = (trigger?: EmbeddedRunAttemptParams["trigger"]) => {
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      if (trigger) {
        params.trigger = trigger;
      }
      if (trigger === "heartbeat") {
        params.sourceReplyDeliveryMode = "message_tool_only";
      }
      return params;
    };

    const registeredTools = [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("heartbeat_respond"),
    ];
    const normalBridge = createCodexToolBridgeForTest(
      createRunParams(),
      [createRuntimeDynamicTool("message")],
      registeredTools,
    );
    const normalInstructions = testing.buildDeveloperInstructions(createRunParams(), {
      dynamicTools: normalBridge.availableSpecs,
    });
    const registeredToolNames = normalBridge.specs.map((tool) => tool.name);

    expect(registeredToolNames).toContain("message");
    expect(registeredToolNames).toContain("heartbeat_respond");
    expect(normalInstructions).toContain(
      "Deferred searchable OpenClaw dynamic tools available: message.",
    );
    expect(normalInstructions).not.toContain(
      "Deferred searchable OpenClaw dynamic tools available: heartbeat_respond",
    );

    const heartbeatBridge = createCodexToolBridgeForTest(
      createRunParams("heartbeat"),
      [createRuntimeDynamicTool("message"), createRuntimeDynamicTool("heartbeat_respond")],
      registeredTools,
    );
    const nextNormalBridge = createCodexToolBridgeForTest(
      createRunParams(),
      [createRuntimeDynamicTool("message")],
      registeredTools,
    );

    expect(heartbeatBridge.specs.map((tool) => tool.name)).toEqual(registeredToolNames);
    expect(nextNormalBridge.specs.map((tool) => tool.name)).toEqual(registeredToolNames);
  });

  it("keeps the persistent dynamic schema stable across heartbeat-only turns", async () => {
    testing.setOpenClawCodingToolsFactoryForTests((options) => [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("web_search"),
      ...(options?.enableHeartbeatTool === true
        ? [createRuntimeDynamicTool("heartbeat_respond")]
        : []),
    ]);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const createRunParams = (trigger?: EmbeddedRunAttemptParams["trigger"]) => {
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = false;
      const runtimePlan = createCodexRuntimePlanFixture();
      params.runtimePlan = {
        ...runtimePlan,
        tools: {
          normalize: (tools: Array<{ name: string }>) =>
            trigger === "heartbeat"
              ? tools.filter((tool) => tool.name === "heartbeat_respond")
              : tools,
          logDiagnostics: () => undefined,
        },
      } as unknown as NonNullable<EmbeddedRunAttemptParams["runtimePlan"]>;
      if (trigger) {
        params.trigger = trigger;
      }
      return params;
    };
    const registeredTools = [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("web_search"),
      createRuntimeDynamicTool("heartbeat_respond"),
    ];
    const normalBridge = createCodexToolBridgeForTest(
      createRunParams(),
      registeredTools,
      registeredTools,
    );
    const heartbeatBridge = createCodexToolBridgeForTest(
      createRunParams("heartbeat"),
      [createRuntimeDynamicTool("heartbeat_respond")],
      registeredTools,
    );
    const nextNormalBridge = createCodexToolBridgeForTest(
      createRunParams(),
      registeredTools,
      registeredTools,
    );

    expect(heartbeatBridge.availableSpecs.map((tool) => tool.name)).toEqual(["heartbeat_respond"]);
    expect(heartbeatBridge.specs.map((tool) => tool.name)).toEqual(
      normalBridge.specs.map((tool) => tool.name),
    );
    expect(nextNormalBridge.specs.map((tool) => tool.name)).toEqual(
      normalBridge.specs.map((tool) => tool.name),
    );
  });

  it("disables Codex native tool surfaces when runtime toolsAllow is empty", async () => {
    testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("web_search"),
    ]);
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = [];
    params.extraSystemPrompt = "Tool and file actions are disabled for this sender by chat policy.";

    const { request, nativeToolSurfaceEnabled } = await startThreadWithDisabledNativeSurfaceForTest(
      params,
      {
        pluginConfig: {
          appServer: { mode: "yolo" },
          codexPlugins: {
            enabled: true,
            plugins: {
              "google-calendar": {
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
              },
            },
          },
        },
        developerInstructions: params.extraSystemPrompt,
      },
    );

    const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startRequest?.[1] as
      | {
          dynamicTools?: Array<{ name?: string }>;
          environments?: unknown[];
          developerInstructions?: string;
          config?: {
            "features.code_mode"?: boolean;
            "features.code_mode_only"?: boolean;
            apps?: Record<
              string,
              { enabled?: boolean; destructive_enabled?: boolean; open_world_enabled?: boolean }
            >;
          };
        }
      | undefined;

    expect(nativeToolSurfaceEnabled).toBe(false);
    expect(startParams?.dynamicTools).toEqual([]);
    expect(startParams?.environments).toEqual([]);
    expect(startParams?.developerInstructions).toContain(
      "Tool and file actions are disabled for this sender by chat policy.",
    );
    expect(startParams?.config?.["features.code_mode"]).toBe(false);
    expect(startParams?.config?.["features.code_mode_only"]).toBe(false);
    expect(startParams?.config?.apps?.["_default"]).toEqual({
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    });
    expect(startParams?.config?.apps?.["google-calendar-app"]?.enabled).toBeUndefined();
    expect(request.mock.calls.map(([method]) => method)).not.toContain("app/list");
  });

  it("fails closed for Codex app defaults when restricted native tools have no plugin config", async () => {
    testing.setOpenClawCodingToolsFactoryForTests(() => [createRuntimeDynamicTool("message")]);
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = [];

    const { request } = await startThreadWithDisabledNativeSurfaceForTest(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });

    const startRequest = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startRequest?.[1] as
      | {
          config?: {
            apps?: Record<
              string,
              { enabled?: boolean; destructive_enabled?: boolean; open_world_enabled?: boolean }
            >;
          };
        }
      | undefined;

    expect(startParams?.config?.apps?.["_default"]).toEqual({
      enabled: false,
      destructive_enabled: false,
      open_world_enabled: false,
    });
    expect(request.mock.calls.map(([method]) => method)).not.toContain("app/list");
  });

  it("keeps searchable Codex dynamic tools canonical in mirrored transcript snapshots", async () => {
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
    projector.recordDynamicToolCall({
      callId: "call-wiki-status-1",
      tool: "wiki_status",
      arguments: { topic: "README.md" },
    });
    projector.recordDynamicToolResult({
      callId: "call-wiki-status-1",
      tool: "wiki_status",
      success: true,
      terminalType: "completed",
      contentItems: [{ type: "inputText", text: "wiki_status done" }],
    });
    const result = projector.buildResult(buildEmptyCodexToolTelemetry());

    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const assistantMessage = result.messagesSnapshot[1];
    if (assistantMessage?.role !== "assistant") {
      throw new Error("expected mirrored assistant tool-call message");
    }
    expect(assistantMessage.content).toStrictEqual([
      {
        type: "toolCall",
        id: "call-wiki-status-1",
        name: "wiki_status",
        arguments: { topic: "README.md" },
        input: { topic: "README.md" },
      },
    ]);
    const toolResultMessage = result.messagesSnapshot[2];
    if (toolResultMessage?.role !== "toolResult") {
      throw new Error("expected mirrored tool-result message");
    }
    expect(toolResultMessage.toolCallId).toBe("call-wiki-status-1");
    expect(toolResultMessage.toolName).toBe("wiki_status");
    expect(toolResultMessage.isError).toBe(false);
    expect(toolResultMessage.content).toStrictEqual([
      {
        type: "toolResult",
        id: "call-wiki-status-1",
        name: "wiki_status",
        toolName: "wiki_status",
        toolCallId: "call-wiki-status-1",
        toolUseId: "call-wiki-status-1",
        tool_use_id: "call-wiki-status-1",
        content: "wiki_status done",
        text: "wiki_status done",
      },
    ]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("tool_search");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("function_call_output");
  });

  it("applies before_prompt_build to Codex developer instructions and turn input", async () => {
    const beforePromptBuild = vi.fn(async () => ({
      systemPrompt: "custom codex system",
      prependSystemContext: "pre system",
      appendSystemContext: "post system",
      prependContext: "queued context",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(assistantMessage("previous turn", Date.now()));
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(beforePromptBuild).toHaveBeenCalledOnce();
    const [hookInput, hookContext] = mockCall(beforePromptBuild, "before_prompt_build") as [
      { messages?: Array<{ role?: string }>; prompt?: string },
      { runId?: string; sessionId?: string },
    ];
    expect(hookInput.prompt).toBe("hello");
    expect(hookInput.messages).toEqual([]);
    expect(hookContext.runId).toBe("run-1");
    expect(hookContext.sessionId).toBe("session-1");
    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as { developerInstructions?: string } | undefined;
    const wrappedPluginSystemContext = (text: string) =>
      `---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\n${text}\n\n---`;
    expect(threadStartParams?.developerInstructions).toContain(
      `${wrappedPluginSystemContext("pre system")}\n\ncustom codex system\n\n${wrappedPluginSystemContext("post system")}`,
    );
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as
      | { input?: Array<{ text?: string; text_elements?: unknown[]; type?: string }> }
      | undefined;
    expect(turnStartParams?.input).toEqual([
      { type: "text", text: "queued context\n\nhello", text_elements: [] },
    ]);
  });

  it("does not inject mirrored history when starting Codex without a native thread binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(userMessage("we are fixing the Opik default project", Date.now()));
    sessionManager.appendMessage(assistantMessage("Opik default project context", Date.now() + 1));
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "make the default webpage openclaw";

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";

    expect(inputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(inputText).not.toContain("we are fixing the Opik default project");
    expect(inputText).not.toContain("Opik default project context");
    expect(inputText).not.toContain("Current user request:");
    expect(inputText).toContain("make the default webpage openclaw");
  });

  it("does not inject newer mirrored history when resuming an existing Codex thread binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const binding = await readCodexAppServerBinding(sessionFile);
    const bindingUpdatedAt = Date.parse(binding?.updatedAt ?? "");
    if (!Number.isFinite(bindingUpdatedAt)) {
      throw new Error("expected valid Codex binding timestamp");
    }
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(
      userMessage("we were discussing the Sonnet leak screenshots", bindingUpdatedAt + 1_000),
    );
    sessionManager.appendMessage(
      assistantMessage("David Ondrej was mentioned in that prior thread", bindingUpdatedAt + 2_000),
    );
    const harness = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "is the previous message trustworthy?";

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expect(harness.requests.map((request) => request.method)).toContain("thread/resume");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";

    expect(inputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(inputText).not.toContain("we were discussing the Sonnet leak screenshots");
    expect(inputText).not.toContain("David Ondrej was mentioned in that prior thread");
    expect(inputText).not.toContain("Current user request:");
    expect(inputText).toContain("is the previous message trustworthy?");
  });

  it("does not project mirrored messages on consecutive resumes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const oldBindingUpdatedAt = Date.now() - 60_000;
    const bindingPath = `${sessionFile}.codex-app-server.json`;
    const bindingPayload = JSON.parse(await fs.readFile(bindingPath, "utf8")) as Record<
      string,
      unknown
    >;
    bindingPayload.updatedAt = new Date(oldBindingUpdatedAt).toISOString();
    await fs.writeFile(bindingPath, `${JSON.stringify(bindingPayload, null, 2)}\n`);
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(
      userMessage("we were discussing the Sonnet leak screenshots", oldBindingUpdatedAt + 1_000),
    );
    sessionManager.appendMessage(
      assistantMessage(
        "David Ondrej was mentioned in that prior thread",
        oldBindingUpdatedAt + 2_000,
      ),
    );

    const firstHarness = createResumeHarness();
    const firstParams = createParams(sessionFile, workspaceDir);
    firstParams.prompt = "is the previous message trustworthy?";
    const firstRun = runCodexAppServerAttempt(firstParams);
    await firstHarness.waitForMethod("turn/start");
    await firstHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await firstRun;

    const firstTurnStart = firstHarness.requests.find((request) => request.method === "turn/start");
    const firstInputText =
      (firstTurnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]
        ?.text ?? "";
    expect(firstInputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(firstInputText).not.toContain("we were discussing the Sonnet leak screenshots");
    expect(firstInputText).toContain("is the previous message trustworthy?");

    const secondHarness = createResumeHarness();
    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.prompt = "continue from there";
    const secondRun = runCodexAppServerAttempt(secondParams);
    await secondHarness.waitForMethod("turn/start");
    await secondHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await secondRun;

    const secondTurnStart = secondHarness.requests.find(
      (request) => request.method === "turn/start",
    );
    const secondInputText =
      (secondTurnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]
        ?.text ?? "";
    expect(secondInputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(secondInputText).not.toContain("we were discussing the Sonnet leak screenshots");
    expect(secondInputText).not.toContain("is the previous message trustworthy?");
    expect(secondInputText).toContain("continue from there");
  });

  it("passes stable workspace files as Codex developer instructions and routes MEMORY.md through tools", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentsGuidance = "Follow AGENTS guidance.";
    const soulGuidance = "Soul voice goes here.";
    const identityGuidance = "Identity guidance goes here.";
    const toolGuidance = "Tool guidance goes here.";
    const userProfile = "User profile goes here.";
    const memorySummary = "Memory summary goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), agentsGuidance);
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), soulGuidance);
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), identityGuidance);
    await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), toolGuidance);
    await fs.writeFile(path.join(workspaceDir, "USER.md"), userProfile);
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("memory_search"),
      createRuntimeDynamicTool("memory_get"),
    ]);
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setAgentWorkspaceForTest(params, workspaceDir);
    const {
      collaborationInstructions,
      inputText,
      systemPromptReport,
      threadDeveloperInstructions,
    } = await buildCodexTurnContextForTest(params, workspaceDir);

    expect(threadDeveloperInstructions).toContain("OpenClaw Workspace Instructions");
    expect(threadDeveloperInstructions).not.toContain(soulGuidance);
    expect(threadDeveloperInstructions).not.toContain(identityGuidance);
    expect(threadDeveloperInstructions).toContain(toolGuidance);
    expect(threadDeveloperInstructions).not.toContain(userProfile);
    expect(threadDeveloperInstructions).not.toContain(memorySummary);
    expect(threadDeveloperInstructions).not.toContain("Codex loads AGENTS.md natively");
    expect(threadDeveloperInstructions).not.toContain(agentsGuidance);

    expect(collaborationInstructions).toContain("# Collaboration Mode: Default");
    expect(collaborationInstructions).toContain("request_user_input availability");
    expect(collaborationInstructions).toContain("OpenClaw Agent Soul");
    expect(collaborationInstructions).toContain("<AGENT_SOUL>");
    expect(collaborationInstructions).toContain("</AGENT_SOUL>");
    expect(collaborationInstructions).toContain(soulGuidance);
    expect(collaborationInstructions).toContain(identityGuidance);
    expect(collaborationInstructions).not.toContain(toolGuidance);
    expect(collaborationInstructions).toContain(userProfile);
    expect(collaborationInstructions).toContain("OpenClaw Workspace Memory");
    expect(collaborationInstructions).toContain(
      "MEMORY.md exists in the active agent workspace as a memory file, not an instruction file",
    );
    expect(collaborationInstructions).toContain("memory_search");
    expect(collaborationInstructions).toContain("memory_get");
    expect(collaborationInstructions).not.toContain(memorySummary);
    expect(inputText).not.toContain("OpenClaw runtime context for this turn:");
    expect(inputText).not.toContain("does not override Codex system/developer instructions");
    expect(inputText).not.toContain("not developer policy");
    expect(inputText).not.toContain(soulGuidance);
    expect(inputText).not.toContain(identityGuidance);
    expect(inputText).not.toContain(toolGuidance);
    expect(inputText).not.toContain(userProfile);
    expect(inputText).not.toContain(memorySummary);
    expect(inputText).not.toContain("OpenClaw Workspace Memory");
    expect(inputText).not.toContain("MEMORY.md exists in the active agent workspace");
    expect(inputText).not.toContain("memory_search");
    expect(inputText).not.toContain("memory_get");
    expect(inputText).not.toContain("Codex loads AGENTS.md natively");
    expect(inputText).not.toContain(agentsGuidance);
    expect(inputText).toBe("hello");
    expect(systemPromptReport.systemPrompt.chars).toBe(
      [threadDeveloperInstructions, collaborationInstructions].join("\n\n").length,
    );

    const fileStats = new Map(
      systemPromptReport.injectedWorkspaceFiles.map((file) => [file.name, file]),
    );
    expect(fileStats.get("SOUL.md")).toMatchObject({
      rawChars: soulGuidance.length,
      injectedChars: soulGuidance.length,
      truncated: false,
    });
    expect(fileStats.get("IDENTITY.md")).toMatchObject({
      rawChars: identityGuidance.length,
      injectedChars: identityGuidance.length,
      truncated: false,
    });
    expect(fileStats.get("TOOLS.md")).toMatchObject({
      rawChars: toolGuidance.length,
      injectedChars: toolGuidance.length,
      truncated: false,
    });
    expect(fileStats.get("USER.md")).toMatchObject({
      rawChars: userProfile.length,
      injectedChars: userProfile.length,
      truncated: false,
    });
    expect(fileStats.get("MEMORY.md")).toMatchObject({
      rawChars: memorySummary.length,
      injectedChars: 0,
      truncated: false,
    });
    expect(fileStats.get("AGENTS.md")).toMatchObject({
      rawChars: agentsGuidance.length,
      injectedChars: agentsGuidance.length,
      truncated: false,
    });
  });

  it("sends workspace bootstrap instructions through Codex app-server payloads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentsGuidance = "Follow AGENTS guidance.";
    const soulGuidance = "Soul voice goes here.";
    const identityGuidance = "Identity guidance goes here.";
    const toolGuidance = "Tool guidance goes here.";
    const userProfile = "User profile goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), agentsGuidance);
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), soulGuidance);
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), identityGuidance);
    await fs.writeFile(path.join(workspaceDir, "TOOLS.md"), toolGuidance);
    await fs.writeFile(path.join(workspaceDir, "USER.md"), userProfile);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    setAgentWorkspaceForTest(params, workspaceDir);

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as {
      config?: { instructions?: string };
      developerInstructions?: string;
    };
    expect(threadStartParams.config?.instructions).toBeUndefined();
    expect(threadStartParams.developerInstructions).toContain("OpenClaw Workspace Instructions");
    expect(threadStartParams.developerInstructions).toContain(toolGuidance);
    expect(threadStartParams.developerInstructions).not.toContain(agentsGuidance);
    expect(threadStartParams.developerInstructions).not.toContain(soulGuidance);
    expect(threadStartParams.developerInstructions).not.toContain(identityGuidance);
    expect(threadStartParams.developerInstructions).not.toContain(userProfile);

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      input?: Array<{ text?: string }>;
      collaborationMode?: {
        settings?: {
          developer_instructions?: string | null;
        };
      };
    };
    const collaborationInstructions =
      turnStartParams.collaborationMode?.settings?.developer_instructions ?? "";
    expect(collaborationInstructions).toContain("OpenClaw Agent Soul");
    expect(collaborationInstructions).toContain("<AGENT_SOUL>");
    expect(collaborationInstructions).toContain("</AGENT_SOUL>");
    expect(collaborationInstructions).toContain(soulGuidance);
    expect(collaborationInstructions).toContain(identityGuidance);
    expect(collaborationInstructions).toContain(userProfile);
    expect(collaborationInstructions).not.toContain(toolGuidance);

    const inputText = turnStartParams.input?.[0]?.text ?? "";
    expect(inputText).toBe("hello");
    expect(inputText).not.toContain(agentsGuidance);
    expect(result.systemPromptReport?.systemPrompt.chars).toBe(
      [threadStartParams.developerInstructions ?? "", collaborationInstructions].join("\n\n")
        .length,
    );
  });

  it("injects bounded MEMORY.md when memory tools are unavailable", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const memorySummary = "Memory summary goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      input?: Array<{ text?: string }>;
    };
    const inputText = turnStartParams.input?.[0]?.text ?? "";
    expect(inputText).not.toContain("OpenClaw Workspace Memory");
    expect(inputText).not.toContain("memory_search");
    expect(inputText).toContain(memorySummary);

    const fileStats = new Map(
      result.systemPromptReport?.injectedWorkspaceFiles.map((file) => [file.name, file]) ?? [],
    );
    expect(fileStats.get("MEMORY.md")).toMatchObject({
      rawChars: memorySummary.length,
      injectedChars: memorySummary.length,
      truncated: false,
    });
  });

  it("routes MEMORY.md through memory_get when search is unavailable", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const memorySummary = "Memory summary goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    testing.setOpenClawCodingToolsFactoryForTests(() => [createRuntimeDynamicTool("memory_get")]);
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setAgentWorkspaceForTest(params, workspaceDir);

    const { collaborationInstructions, inputText, systemPromptReport } =
      await buildCodexTurnContextForTest(params, workspaceDir);
    expect(inputText).not.toContain("OpenClaw Workspace Memory");
    expect(inputText).not.toContain("memory_get");
    expect(inputText).not.toContain("memory_search");
    expect(inputText).not.toContain(memorySummary);
    expect(collaborationInstructions).toContain("OpenClaw Workspace Memory");
    expect(collaborationInstructions).toContain("memory_get");
    expect(collaborationInstructions).not.toContain("memory_search");
    expect(collaborationInstructions).not.toContain(memorySummary);

    const fileStats = new Map(
      systemPromptReport.injectedWorkspaceFiles.map((file) => [file.name, file]),
    );
    expect(fileStats.get("MEMORY.md")).toMatchObject({
      rawChars: memorySummary.length,
      injectedChars: 0,
      truncated: false,
    });
  });

  it("reports MEMORY.md as truncated when no-tool fallback exceeds the bootstrap budget", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const soulGuidance = "Soul guidance ".repeat(80);
    const memorySummary = "Memory summary goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), soulGuidance);
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.config = {
      agents: {
        defaults: {
          bootstrapMaxChars: 1000,
          bootstrapTotalMaxChars: 1000,
        },
      },
    } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    const fileStats = new Map(
      result.systemPromptReport?.injectedWorkspaceFiles.map((file) => [file.name, file]) ?? [],
    );
    expect(fileStats.get("MEMORY.md")).toMatchObject({
      rawChars: memorySummary.length,
      injectedChars: 0,
      truncated: true,
    });
  });

  it("keeps MEMORY.md out of the Codex workspace context budget", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const memorySummary = "Memory summary ".repeat(300);
    const hookContext = "Hook context survives the memory budget.";
    const hookPath = path.join(workspaceDir, "ZZZ.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as {
        bootstrapFiles: Array<{ content: string; missing: boolean; name?: string; path: string }>;
      };
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "ZZZ.md",
          path: hookPath,
          content: hookContext,
          missing: false,
        },
      ];
    });
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          bootstrapMaxChars: 1000,
          bootstrapTotalMaxChars: 2000,
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("memory_search"),
      createRuntimeDynamicTool("memory_get"),
    ]);

    const { collaborationInstructions, inputText, systemPromptReport } =
      await buildCodexTurnContextForTest(params, workspaceDir);
    expect(inputText).not.toContain("OpenClaw Workspace Memory");
    expect(inputText).not.toContain(memorySummary);
    expect(inputText).toContain(hookContext);
    expect(collaborationInstructions).toContain("OpenClaw Workspace Memory");
    expect(collaborationInstructions).not.toContain(memorySummary);

    const fileStats = new Map(
      systemPromptReport.injectedWorkspaceFiles.map((file) => [file.name, file]),
    );
    expect(fileStats.get("MEMORY.md")).toMatchObject({
      rawChars: memorySummary.trimEnd().length,
      injectedChars: 0,
      truncated: false,
    });
    expect(fileStats.get("ZZZ.md")).toMatchObject({
      rawChars: hookContext.length,
      injectedChars: hookContext.length,
      truncated: false,
    });
  });

  it("keeps extra MEMORY.md bootstrap files in Codex workspace context", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const rootMemory = "Root memory should stay tool-routed.";
    const nestedMemory = "Nested package memory remains prompt context.";
    const nestedMemoryPath = path.join(workspaceDir, "packages/pkg/MEMORY.md");
    await fs.mkdir(path.dirname(nestedMemoryPath), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), rootMemory);
    await fs.writeFile(nestedMemoryPath, nestedMemory);
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as {
        bootstrapFiles: Array<{ content: string; missing: boolean; name?: string; path: string }>;
      };
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "MEMORY.md",
          path: nestedMemoryPath,
          content: nestedMemory,
          missing: false,
        },
      ];
    });
    testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("memory_search"),
      createRuntimeDynamicTool("memory_get"),
    ]);
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setAgentWorkspaceForTest(params, workspaceDir);

    const { collaborationInstructions, inputText, systemPromptReport } =
      await buildCodexTurnContextForTest(params, workspaceDir);
    expect(inputText).not.toContain("OpenClaw Workspace Memory");
    expect(inputText).not.toContain(rootMemory);
    expect(inputText).toContain(nestedMemory);
    expect(collaborationInstructions).toContain("OpenClaw Workspace Memory");
    expect(collaborationInstructions).not.toContain(rootMemory);
    expect(collaborationInstructions).not.toContain(nestedMemory);

    const files = systemPromptReport.injectedWorkspaceFiles;
    const rootMemoryStats = files.find(
      (file) => file.path === path.join(workspaceDir, "MEMORY.md"),
    );
    const nestedMemoryStats = files.find((file) => file.path === nestedMemoryPath);
    expect(rootMemoryStats).toMatchObject({
      rawChars: rootMemory.length,
      injectedChars: 0,
      truncated: false,
    });
    expect(nestedMemoryStats).toMatchObject({
      rawChars: nestedMemory.length,
      injectedChars: nestedMemory.length,
      truncated: false,
    });
  });

  it("injects MEMORY.md when active workspace is not the memory tool workspace", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const memorySummary = "Memory summary goes here.";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("memory_search"),
      createRuntimeDynamicTool("memory_get"),
    ]);
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setAgentWorkspaceForTest(params, path.join(tempDir, "memory-workspace"));

    const { inputText, systemPromptReport } = await buildCodexTurnContextForTest(
      params,
      workspaceDir,
    );
    expect(inputText).not.toContain("OpenClaw Workspace Memory");
    expect(inputText).toContain(memorySummary);

    const fileStats = new Map(
      systemPromptReport.injectedWorkspaceFiles.map((file) => [file.name, file]),
    );
    expect(fileStats.get("MEMORY.md")).toMatchObject({
      rawChars: memorySummary.length,
      injectedChars: memorySummary.length,
      truncated: false,
    });
  });

  it("reports hook-supplied bootstrap files that only expose path and content", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const soulPath = path.join(workspaceDir, "SOUL.md");
    const soulGuidance = "Hook supplied soul guidance.";
    await fs.mkdir(workspaceDir, { recursive: true });
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as {
        bootstrapFiles: Array<{ content: string; missing: boolean; path: string }>;
      };
      context.bootstrapFiles = [
        {
          path: soulPath,
          content: soulGuidance,
          missing: false,
        },
      ];
    });
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(result.systemPromptReport?.injectedWorkspaceFiles).toEqual([
      expect.objectContaining({
        name: "SOUL.md",
        path: soulPath,
        rawChars: soulGuidance.length,
        injectedChars: soulGuidance.length,
        truncated: false,
      }),
    ]);
  });

  it("points heartbeat Codex turns at HEARTBEAT.md without injecting its contents", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(heartbeatPath, "Heartbeat checklist goes here.");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "heartbeat";
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "heartbeat";

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as {
      developerInstructions?: string;
    };
    expect(threadStartParams.developerInstructions).not.toContain("Heartbeat checklist goes here.");

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      input?: Array<{ text?: string }>;
      collaborationMode?: {
        settings?: {
          developer_instructions?: string | null;
        };
      };
    };
    const inputText = turnStartParams.input?.[0]?.text ?? "";
    const collaborationInstructions =
      turnStartParams.collaborationMode?.settings?.developer_instructions ?? "";

    expect(inputText).not.toContain("Heartbeat checklist goes here.");
    expect(collaborationInstructions).toContain("HEARTBEAT.md exists");
    expect(collaborationInstructions).toContain("Read it before proceeding with this heartbeat");
    expect(collaborationInstructions).toContain(heartbeatPath);
    expect(collaborationInstructions).not.toContain("Heartbeat checklist goes here.");
  });

  it("omits heartbeat Codex workspace pointers for empty HEARTBEAT.md files", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "\n\n");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "heartbeat";
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "heartbeat";

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      collaborationMode?: {
        settings?: {
          developer_instructions?: string | null;
        };
      };
    };
    const collaborationInstructions =
      turnStartParams.collaborationMode?.settings?.developer_instructions ?? "";

    expect(collaborationInstructions).toContain("This is an OpenClaw heartbeat turn");
    expect(collaborationInstructions).not.toContain("HEARTBEAT.md exists");
  });

  it("keeps lightweight cron Codex turns out of OpenClaw bootstrap context", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const exactCommand =
      "cd /Users/phaedrus/Projects/openclaw && /Users/phaedrus/clawd/scripts/clawsweeper-related-scan.py";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "cron";
    params.prompt = exactCommand;
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "cron";
    params.skillsSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [],
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as {
      developerInstructions?: string;
      config?: Record<string, unknown>;
    };
    expect(threadStartParams.config?.project_doc_max_bytes).toBe(0);
    expect(threadStartParams.developerInstructions).not.toContain("Soul voice goes here.");
    expect(threadStartParams.developerInstructions).not.toContain("Follow AGENTS guidance.");
    expect(threadStartParams.developerInstructions).not.toContain("<available_skills>");

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      input?: Array<{ text?: string }>;
    };
    expect(turnStartParams.input?.[0]?.text).toBe(exactCommand);
    expect(result.systemPromptReport?.skills).toMatchObject({ promptChars: 0, entries: [] });
    expect(result.systemPromptReport?.skills.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps lightweight cron delivery hints byte-for-byte without OpenClaw prompt context", async () => {
    const sessionFile = path.join(tempDir, "session-lightweight-cron-delivery.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-lightweight-cron-delivery");
    const exactPrompt =
      "Delivery: to send a message, use the `message` tool.\n\ncd /repo && ./scripts/run-cron";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "Bootstrap context.");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "cron";
    params.prompt = exactPrompt;
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "cron";
    params.skillsSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [],
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as {
      input?: Array<{ text?: string }>;
    };
    expect(turnStartParams.input?.[0]?.text).toBe(exactPrompt);
  });

  it("forwards Codex app-server verbose tool summaries and completed output", async () => {
    const onToolResult = vi.fn();
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.verboseLevel = "full";
    params.onToolResult = onToolResult;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "read",
          arguments: { path: "README.md" },
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      },
    });
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "read",
          arguments: { path: "README.md" },
          status: "completed",
          contentItems: [{ type: "inputText", text: "file contents" }],
          success: true,
          durationMs: 12,
        },
      },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(onToolResult).toHaveBeenNthCalledWith(1, {
      text: "📖 Read: `from README.md`",
    });
    expect(onToolResult).toHaveBeenNthCalledWith(2, {
      text: "📖 Read: `from README.md`\n```txt\nfile contents\n```",
    });
  });

  it("promotes implicit Codex yolo approval policy when OpenClaw tool policy exists", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startParams = startRequest?.params as Record<string, unknown> | undefined;
    expect(startParams?.approvalPolicy).toBe("untrusted");
    expect(startParams?.sandbox).toBe("danger-full-access");
    expect(info).toHaveBeenCalledWith(
      "codex app-server approval policy promoted for OpenClaw tool policy",
      {
        from: "never",
        to: "untrusted",
        beforeToolCallHook: true,
        trustedToolPolicies: [],
      },
    );
  });

  it("keeps explicit Codex yolo mode unpromoted when OpenClaw tool policy exists", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startParams = startRequest?.params as Record<string, unknown> | undefined;
    expect(startParams?.approvalPolicy).toBe("never");
    expect(startParams?.sandbox).toBe("danger-full-access");
  });

  it("keeps normalized full exec mode unpromoted when OpenClaw tool policy exists", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.config = { tools: { exec: { mode: "full" } } } as never;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startParams = startRequest?.params as Record<string, unknown> | undefined;
    expect(startParams?.approvalPolicy).toBe("never");
    expect(startParams?.sandbox).toBe("danger-full-access");
  });

  it("ignores invalid Codex app-server env overrides when promoting tool policy approval", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_MODE", " ");
    vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY", "always");
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startParams = startRequest?.params as Record<string, unknown> | undefined;
    expect(startParams?.approvalPolicy).toBe("untrusted");
  });

  it("preserves a healthy binding when invalid image cleanup hits a transient thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: JSON.stringify([{ name: "message" }]),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-transient");
      }
      if (method === "turn/start") {
        throw new Error("invalid image_url base64 payload");
      }
      return undefined;
    });

    await expect(runCodexAppServerAttempt(createParams(sessionFile, workspaceDir))).rejects.toThrow(
      "invalid image_url base64 payload",
    );

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
  });

  it("preserves a healthy binding when the server rejects unsupported image input", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const harness = createAppServerHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      if (method === "turn/start") {
        throw new Error("unsupported image input");
      }
      return {};
    });

    await expect(runCodexAppServerAttempt(createParams(sessionFile, workspaceDir))).rejects.toThrow(
      "unsupported image input",
    );

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
      "thread/unsubscribe",
    ]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
  });

  it("does not leak unhandled rejections when shutdown closes before interrupt", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const { waitForMethod } = createStartedThreadHarness(async (method) => {
        if (method === "turn/interrupt") {
          throw new Error("codex app-server client is closed");
        }
      });
      const abortController = new AbortController();
      const params = createParams(
        path.join(tempDir, "session.jsonl"),
        path.join(tempDir, "workspace"),
      );
      params.abortSignal = abortController.signal;

      const run = runCodexAppServerAttempt(params);
      await waitForMethod("turn/start");
      abortController.abort("shutdown");

      const result = await run;
      expect(result.aborted).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("forwards image attachments to the app-server turn input", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    params.model = createCodexTestModel("codex", ["text", "image"]);
    params.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: pngBase64,
      },
    ];

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const turnStart = requests.find((entry) => entry.method === "turn/start");
    const turnStartParams = turnStart?.params as
      | { input?: Array<{ text?: string; text_elements?: unknown[]; type?: string; url?: string }> }
      | undefined;
    expect(turnStartParams?.input).toEqual([
      { type: "text", text: "hello", text_elements: [] },
      { type: "image", url: `data:image/png;base64,${pngBase64}` },
    ]);
  });

  it("does not drop turn completion notifications emitted while turn/start is in flight", async () => {
    let harness: ReturnType<typeof createAppServerHarness>;
    harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        return turnStartResult("turn-1", "completed");
      }
      return {};
    });

    const result = await runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("does not fail when a buffered terminal notification is followed by client close", async () => {
    let harness: ReturnType<typeof createAppServerHarness>;
    let resolveBufferedTerminal!: () => void;
    const bufferedTerminal = new Promise<void>((resolve) => {
      resolveBufferedTerminal = resolve;
    });
    harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        await harness.notify({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "tool-1", type: "commandExecution" },
          },
        });
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        resolveBufferedTerminal();
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { turnTerminalIdleTimeoutMs: 60_000 },
    );
    await bufferedTerminal;
    await new Promise<void>((resolve) => setImmediate(resolve));
    harness.close();

    const result = await run;
    expect(result.promptError ?? undefined).toBeUndefined();
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("does not time out when turn progress arrives before turn/start returns", async () => {
    let harness: ReturnType<typeof createAppServerHarness>;
    harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        await harness.notify({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        });
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 60_000,
    });
    await harness.waitForMethod("turn/start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("completes when turn/start returns a terminal turn without a follow-up notification", async () => {
    const harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "done from response" }],
          },
        };
      }
      return {};
    });

    const result = await runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );

    expect(harness.requests.map((entry) => entry.method)).toContain("turn/start");
    expect(result.assistantTexts).toEqual(["done from response"]);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("surfaces Codex-native image generation saved paths as reply media", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [
            {
              type: "imageGeneration",
              id: "ig_123",
              status: "completed",
              revisedPrompt: "A tiny blue square",
              result: "Zm9v",
              savedPath: "/tmp/codex-home/generated_images/session-1/ig_123.png",
            },
          ],
        },
      },
    });

    const result = await run;
    expect(result.assistantTexts).toEqual([]);
    expect(result.toolMediaUrls).toEqual(["/tmp/codex-home/generated_images/session-1/ig_123.png"]);
  });

  it("does not complete on unscoped turn/completed notifications", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-wrong", text: "wrong completion" }],
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-right", text: "final completion" }],
        },
      },
    });

    const result = await run;
    expect(result.assistantTexts).toEqual(["final completion"]);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("ignores turn/completed notifications for other subscribed threads", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-other",
        turn: {
          id: "turn-other",
          status: "completed",
          items: [],
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    expect(
      warn.mock.calls.some(([message]) =>
        message.includes("turn/completed did not match active turn"),
      ),
    ).toBe(false);

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-right", text: "final completion" }],
        },
      },
    });

    const result = await run;
    expect(result.assistantTexts).toEqual(["final completion"]);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("routes Computer Use MCP elicitations through the native bridge", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const bridgeSpy = vi
      .spyOn(elicitationBridge, "handleCodexAppServerElicitationRequest")
      .mockResolvedValue({
        action: "accept",
        content: { approve: true },
        _meta: null,
      });
    const request = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
        return {
          marketplaces: [
            {
              name: "openai-bundled",
              path: "/marketplaces/openai-bundled",
              plugins: [
                {
                  id: "computer-use@openai-bundled",
                  name: "computer-use",
                  source: {
                    type: "local",
                    path: "/marketplaces/openai-bundled/plugins/computer-use",
                  },
                  installed: true,
                  enabled: true,
                },
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        };
      }
      if (method === "plugin/read") {
        return {
          plugin: {
            marketplaceName: "openai-bundled",
            marketplacePath: "/marketplaces/openai-bundled",
            summary: {
              id: "computer-use@openai-bundled",
              name: "computer-use",
              source: {
                type: "local",
                path: "/marketplaces/openai-bundled/plugins/computer-use",
              },
              installed: true,
              enabled: true,
            },
            description: null,
            skills: [],
            apps: [],
            mcpServers: ["computer-use"],
          },
        };
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "desktop-control",
              tools: {
                "computer-use.get_app_state": {},
              },
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: (
            handler: (request: {
              id: string;
              method: string;
              params?: unknown;
            }) => Promise<unknown>,
          ) => {
            handleRequest = handler;
            return () => undefined;
          },
        }) as never,
    );

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      {
        pluginConfig: {
          computerUse: {
            enabled: true,
            marketplaceName: "openai-bundled",
            mcpServerName: "desktop-control",
          },
        },
      },
    );
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"));

    const result = await handleRequest?.({
      id: "request-elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "desktop-control",
        mode: "form",
      },
    });

    expect(result).toEqual({
      action: "accept",
      content: { approve: true },
      _meta: null,
    });
    const [bridgeCall] = mockCall(bridgeSpy, "elicitation bridge") as [
      {
        requestParams?: { serverName?: string };
        computerUseMcpServerName?: string;
        threadId?: string;
        turnId?: string;
      },
    ];
    expect(bridgeCall.threadId).toBe("thread-1");
    expect(bridgeCall.turnId).toBe("turn-1");
    expect(bridgeCall.requestParams?.serverName).toBe("desktop-control");
    expect(bridgeCall.computerUseMcpServerName).toBe("desktop-control");
    const requestCalls = request.mock.calls as unknown as Array<[string, unknown, unknown?]>;
    const threadStart = requestCalls.find(([method]) => method === "thread/start");
    const threadStartParams = threadStart?.[1] as
      | { approvalPolicy?: { granular?: { mcp_elicitations?: boolean } } }
      | undefined;
    expect(threadStartParams?.approvalPolicy?.granular?.mcp_elicitations).toBe(true);

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;
  });

  it("passes session plugin app policy context to elicitation handling", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    };
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig: readCodexPluginConfig(pluginConfig),
    });
    defaultCodexAppInventoryCache.clear();
    await defaultCodexAppInventoryCache.refreshNow({
      key: buildCodexPluginAppCacheKey({
        appServer,
        agentDir,
      }),
      request: async () => ({
        data: [
          {
            id: "google-calendar-app",
            name: "Google Calendar",
            description: null,
            logoUrl: null,
            logoUrlDark: null,
            distributionChannel: null,
            branding: null,
            appMetadata: null,
            labels: null,
            installUrl: null,
            isAccessible: true,
            isEnabled: true,
            pluginDisplayNames: [],
          },
        ],
        nextCursor: null,
      }),
    });
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const bridgeSpy = vi
      .spyOn(elicitationBridge, "handleCodexAppServerElicitationRequest")
      .mockResolvedValue({
        action: "decline",
        content: null,
        _meta: null,
      });
    const request = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
        return {
          marketplaces: [
            {
              name: "openai-curated",
              path: "/marketplaces/openai-curated",
              interface: null,
              plugins: [
                {
                  id: "google-calendar",
                  name: "google-calendar",
                  source: { type: "remote" },
                  installed: true,
                  enabled: true,
                  installPolicy: "AVAILABLE",
                  authPolicy: "ON_USE",
                  availability: "AVAILABLE",
                  interface: null,
                },
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        };
      }
      if (method === "plugin/read") {
        return {
          plugin: {
            marketplaceName: "openai-curated",
            marketplacePath: "/marketplaces/openai-curated",
            summary: {
              id: "google-calendar",
              name: "google-calendar",
              source: { type: "remote" },
              installed: true,
              enabled: true,
              installPolicy: "AVAILABLE",
              authPolicy: "ON_USE",
              availability: "AVAILABLE",
              interface: null,
            },
            description: null,
            skills: [],
            apps: [
              {
                id: "google-calendar-app",
                name: "Google Calendar",
                description: null,
                installUrl: null,
                needsAuth: false,
              },
            ],
            mcpServers: ["google-calendar"],
          },
        };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: (
            handler: (request: {
              id: string;
              method: string;
              params?: unknown;
            }) => Promise<unknown>,
          ) => {
            handleRequest = handler;
            return () => undefined;
          },
        }) as never,
    );

    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    const run = runCodexAppServerAttempt(params, { pluginConfig });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"));

    const result = await handleRequest?.({
      id: "request-elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "google-calendar",
        mode: "form",
      },
    });

    expect(result).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    const [bridgeCall] = mockCall(bridgeSpy, "elicitation bridge") as [
      {
        pluginAppPolicyContext?: {
          apps?: Record<string, { mcpServerNames?: string[]; pluginName?: string }>;
        };
        threadId?: string;
        turnId?: string;
      },
    ];
    expect(bridgeCall.threadId).toBe("thread-1");
    expect(bridgeCall.turnId).toBe("turn-1");
    const calendarPolicy = bridgeCall.pluginAppPolicyContext?.apps?.["google-calendar-app"];
    expect(calendarPolicy?.pluginName).toBe("google-calendar");
    expect(calendarPolicy?.mcpServerNames).toEqual(["google-calendar"]);
    const requestCalls = request.mock.calls as unknown as Array<[string, unknown, unknown?]>;
    const threadStart = requestCalls.find(([method]) => method === "thread/start");
    const threadStartParams = threadStart?.[1] as
      | { approvalPolicy?: { granular?: { mcp_elicitations?: boolean } } }
      | undefined;
    expect(threadStartParams?.approvalPolicy?.granular?.mcp_elicitations).toBe(true);
    const turnStart = requestCalls.find(([method]) => method === "turn/start");
    const turnStartParams = turnStart?.[1] as
      | { approvalPolicy?: { granular?: { mcp_elicitations?: boolean } } }
      | undefined;
    expect(turnStartParams?.approvalPolicy?.granular?.mcp_elicitations).toBe(true);

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;
  });

  it("keys plugin app inventory by the resolved Codex account", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const authProfileId = "openai-codex:work";
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    };
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig: readCodexPluginConfig(pluginConfig),
    });
    defaultCodexAppInventoryCache.clear();
    await defaultCodexAppInventoryCache.refreshNow({
      key: buildCodexPluginAppCacheKey({
        appServer,
        agentDir,
        authProfileId,
        accountId: "account-work",
      }),
      request: async () => ({
        data: [
          {
            id: "google-calendar-app",
            name: "Google Calendar",
            description: null,
            logoUrl: null,
            logoUrlDark: null,
            distributionChannel: null,
            branding: null,
            appMetadata: null,
            labels: null,
            installUrl: null,
            isAccessible: true,
            isEnabled: true,
            pluginDisplayNames: [],
          },
        ],
        nextCursor: null,
      }),
    });
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(async (method) => {
      if (method === "plugin/list") {
        return {
          marketplaces: [
            {
              name: "openai-curated",
              path: "/marketplaces/openai-curated",
              interface: null,
              plugins: [
                {
                  id: "google-calendar",
                  name: "google-calendar",
                  source: { type: "remote" },
                  installed: true,
                  enabled: true,
                  installPolicy: "AVAILABLE",
                  authPolicy: "ON_USE",
                  availability: "AVAILABLE",
                  interface: null,
                },
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        };
      }
      if (method === "plugin/read") {
        return {
          plugin: {
            marketplaceName: "openai-curated",
            marketplacePath: "/marketplaces/openai-curated",
            summary: {
              id: "google-calendar",
              name: "google-calendar",
              source: { type: "remote" },
              installed: true,
              enabled: true,
              installPolicy: "AVAILABLE",
              authPolicy: "ON_USE",
              availability: "AVAILABLE",
              interface: null,
            },
            description: null,
            skills: [],
            apps: [
              {
                id: "google-calendar-app",
                name: "Google Calendar",
                description: null,
                installUrl: null,
                needsAuth: false,
              },
            ],
            mcpServers: ["google-calendar"],
          },
        };
      }
      if (method === "app/list") {
        throw new Error("app/list should use the account-keyed cache entry");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-work",
          email: "work@example.test",
        },
      },
    };

    const run = runCodexAppServerAttempt(params, { pluginConfig });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const threadStart = requests.find((entry) => entry.method === "thread/start");
    const threadStartParams = threadStart?.params as
      | { config?: { apps?: Record<string, { enabled?: boolean }> } }
      | undefined;
    expect(threadStartParams?.config?.apps?.["google-calendar-app"]?.enabled).toBe(true);
    expect(requests.map((entry) => entry.method)).not.toContain("app/list");
  });

  it("keys plugin app inventory by inherited API key fallback credentials", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    };
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig: readCodexPluginConfig(pluginConfig),
    });
    defaultCodexAppInventoryCache.clear();
    await defaultCodexAppInventoryCache.refreshNow({
      key: buildCodexPluginAppCacheKey({
        appServer,
        agentDir,
        envApiKeyFingerprint: resolveCodexAppServerEnvApiKeyCacheKey({
          startOptions: appServer.start,
          baseEnv: { CODEX_API_KEY: "old-codex-env-key" },
        }),
      }),
      request: async () => ({
        data: [
          {
            id: "google-calendar-app",
            name: "Google Calendar",
            description: null,
            logoUrl: null,
            logoUrlDark: null,
            distributionChannel: null,
            branding: null,
            appMetadata: null,
            labels: null,
            installUrl: null,
            isAccessible: true,
            isEnabled: true,
            pluginDisplayNames: [],
          },
        ],
        nextCursor: null,
      }),
    });
    vi.stubEnv("CODEX_API_KEY", "new-codex-env-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(async (method) => {
      if (method === "app/list") {
        return {
          data: [
            {
              id: "google-calendar-app",
              name: "Google Calendar",
              description: null,
              logoUrl: null,
              logoUrlDark: null,
              distributionChannel: null,
              branding: null,
              appMetadata: null,
              labels: null,
              installUrl: null,
              isAccessible: true,
              isEnabled: true,
              pluginDisplayNames: [],
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "plugin/list") {
        return {
          marketplaces: [
            {
              name: "openai-curated",
              path: "/marketplaces/openai-curated",
              interface: null,
              plugins: [
                {
                  id: "google-calendar",
                  name: "google-calendar",
                  source: { type: "remote" },
                  installed: true,
                  enabled: true,
                  installPolicy: "AVAILABLE",
                  authPolicy: "ON_USE",
                  availability: "AVAILABLE",
                  interface: null,
                },
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        };
      }
      if (method === "plugin/read") {
        return {
          plugin: {
            marketplaceName: "openai-curated",
            marketplacePath: "/marketplaces/openai-curated",
            summary: {
              id: "google-calendar",
              name: "google-calendar",
              source: { type: "remote" },
              installed: true,
              enabled: true,
              installPolicy: "AVAILABLE",
              authPolicy: "ON_USE",
              availability: "AVAILABLE",
              interface: null,
            },
            description: null,
            skills: [],
            apps: [
              {
                id: "google-calendar-app",
                name: "Google Calendar",
                description: null,
                installUrl: null,
                needsAuth: false,
              },
            ],
            mcpServers: ["google-calendar"],
          },
        };
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;

    const run = runCodexAppServerAttempt(params, { pluginConfig });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(requests.map((entry) => entry.method)).toContain("app/list");
    const threadStart = requests.find((entry) => entry.method === "thread/start");
    const threadStartParams = threadStart?.params as
      | { config?: { apps?: Record<string, { enabled?: boolean }> } }
      | undefined;
    expect(threadStartParams?.config?.apps?.["google-calendar-app"]?.enabled).toBe(true);
  });

  it("times out app-server startup before thread setup can hang forever", async () => {
    setCodexAppServerClientFactoryForTest(() => new Promise<never>(() => undefined));
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 1;

    await expect(runCodexAppServerAttempt(params, { startupTimeoutFloorMs: 1 })).rejects.toThrow(
      "codex app-server startup timed out",
    );
    expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
  });

  it("passes the selected auth profile into app-server startup", async () => {
    const seenAuthProfileIds: Array<string | undefined> = [];
    const seenAgentDirs: Array<string | undefined> = [];
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(undefined, {
      onStart: (authProfileId, agentDir) => {
        seenAuthProfileIds.push(authProfileId);
        seenAgentDirs.push(agentDir);
      },
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.authProfileId = "openai-codex:work";
    params.agentDir = path.join(tempDir, "agent");

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(seenAuthProfileIds).toEqual(["openai-codex:work"]), {
      interval: 1,
    });
    await waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(seenAuthProfileIds).toEqual(["openai-codex:work"]);
    expect(seenAgentDirs).toEqual([path.join(tempDir, "agent")]);
    expect(requests.map((entry) => entry.method)).toContain("turn/start");
  });

  it("times out turn start before the active run handle is installed", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.")) {
        diagnosticEvents.push(event);
      }
    });
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
        if (method === "thread/start") {
          return threadStartResult("thread-1");
        }
        if (method === "turn/start") {
          return await new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("turn/start timed out")), options?.timeoutMs ?? 0);
          });
        }
        return {};
      },
    );
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          request,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 1;
    params.config = {
      diagnostics: { enabled: true, otel: { enabled: true, traces: true } },
    } as never;

    try {
      await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn/start timed out");
      await flushDiagnosticEvents();

      const errorEvent = diagnosticEvents.find((event) => event.type === "model.call.error") as
        | ({ failureKind?: string; errorCategory?: string } & DiagnosticEventPayload)
        | undefined;
      expect(errorEvent?.failureKind).toBe("timeout");
      expect(errorEvent?.errorCategory).toBe("timeout");
      expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
    } finally {
      stopDiagnostics();
    }
  });

  it("keeps extended history enabled when resuming a bound Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expectResumeRequest(requests, {
      threadId: "thread-existing",
      model: "gpt-5.4-codex",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      persistExtendedHistory: true,
    });
    const resumeRequest = requests.find((request) => request.method === "thread/resume");
    const resumeRequestParams = resumeRequest?.params as Record<string, unknown> | undefined;
    expect(resumeRequestParams?.developerInstructions).not.toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
  });

  it("starts a fresh Codex thread before resume when the native rollout reaches the fallback fuse", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          totalTokens: 12_000,
        },
      }),
    );
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 300_000,
            },
          },
        },
      })}\n`,
    );
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.config = {
      agents: {
        defaults: {
          compaction: {
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: "1mb",
          },
        },
      },
    } as never;

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(requests.map((entry) => entry.method)).toContain("thread/start");
    expect(requests.map((entry) => entry.method)).not.toContain("thread/resume");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-1");
  });

  it("starts a fresh Codex thread before turn/start when the next prompt would exhaust native headroom", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          totalTokens: 12_000,
        },
      }),
    );
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 220_000,
            },
            model_context_window: 258_400,
          },
        },
      })}\n`,
    );
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.prompt = "large prompt ".repeat(12_000);

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(requests.map((entry) => entry.method)).toContain("thread/start");
    expect(requests.map((entry) => entry.method)).not.toContain("thread/resume");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-1");
  });

  it("preserves bound auth when rotating a fallback-fuse native rollout", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai-codex:work",
      dynamicToolsFingerprint: "[]",
    });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          totalTokens: 12_000,
        },
      }),
    );
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 300_000,
            },
          },
        },
      })}\n`,
    );
    const seenAuthProfileIds: Array<string | undefined> = [];
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(undefined, {
      onStart: (authProfileId) => {
        seenAuthProfileIds.push(authProfileId);
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;
    params.agentDir = agentDir;
    params.config = {
      agents: {
        defaults: {
          compaction: {
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: "1mb",
          },
        },
      },
    } as never;

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await vi.waitFor(() => expect(seenAuthProfileIds).toEqual(["openai-codex:work"]), {
      interval: 1,
    });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(requests.map((entry) => entry.method)).toContain("thread/start");
    expect(requests.map((entry) => entry.method)).not.toContain("thread/resume");
    expect(seenAuthProfileIds).toEqual(["openai-codex:work"]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.authProfileId).toBe("openai-codex:work");
    expect(savedBinding?.threadId).toBe("thread-1");
  });

  it("restarts the app-server once when a shared client closes during startup", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const requests: string[][] = [];
    let starts = 0;
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    setCodexAppServerClientFactoryForTest(async () => {
      const startIndex = starts++;
      const methods: string[] = [];
      requests.push(methods);
      return {
        request: vi.fn(async (method: string) => {
          methods.push(method);
          if (method === "thread/resume" && startIndex === 0) {
            throw new Error("codex app-server client is closed");
          }
          if (method === "thread/resume") {
            return threadStartResult("thread-existing");
          }
          if (method === "turn/start") {
            return turnStartResult();
          }
          return {};
        }),
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
      } as never;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await vi.waitFor(() => expect(requests[1]).toContain("turn/start"), fastWait);
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(requests).toEqual([
      ["thread/resume"],
      ["thread/resume", "turn/start", "thread/unsubscribe"],
    ]);
  });

  it("tolerates a second app-server close while retrying startup", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const requests: string[][] = [];
    let starts = 0;
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    setCodexAppServerClientFactoryForTest(async () => {
      const startIndex = starts++;
      const methods: string[] = [];
      requests.push(methods);
      return {
        request: vi.fn(async (method: string) => {
          methods.push(method);
          if (method === "thread/resume" && startIndex < 2) {
            throw new Error("codex app-server client is closed");
          }
          if (method === "thread/resume") {
            return threadStartResult("thread-existing");
          }
          if (method === "turn/start") {
            return turnStartResult();
          }
          return {};
        }),
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
      } as never;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await vi.waitFor(() => expect(requests[2]).toContain("turn/start"), fastWait);
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(requests).toEqual([
      ["thread/resume"],
      ["thread/resume"],
      ["thread/resume", "turn/start", "thread/unsubscribe"],
    ]);
  });

  it("does not retire the shared Codex client when a spawned helper run fails with a logical thread/start error", async () => {
    const clearSpy = vi.spyOn(sharedClientModule, "clearSharedCodexAppServerClientIfCurrent");
    clearSpy.mockClear();
    let failedClient: unknown;
    setCodexAppServerClientFactoryForTest(async () => {
      const c = {
        request: vi.fn(async (method: string) => {
          if (method === "thread/start") {
            throw new CodexAppServerRpcError(
              { message: "401 authentication_error: Invalid bearer token" },
              "thread/start",
            );
          }
          return {};
        }),
        addNotificationHandler: vi.fn(() => () => undefined),
        addRequestHandler: vi.fn(() => () => undefined),
      };
      failedClient = c;
      return c as never;
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.spawnedBy = "agent:main:session-parent";

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("Invalid bearer token");
    const calledWithFailedClient = clearSpy.mock.calls.some(([arg]) => arg === failedClient);
    expect(calledWithFailedClient).toBe(false);
    clearSpy.mockRestore();
  });

  it("retires the shared Codex client when a spawned helper run times out during thread/start", async () => {
    const clearSpy = vi.spyOn(sharedClientModule, "clearSharedCodexAppServerClientIfCurrent");
    clearSpy.mockClear();
    let failedClient: unknown;
    setCodexAppServerClientFactoryForTest(async () => {
      const c = {
        request: vi.fn(async (method: string) => {
          if (method === "thread/start") {
            return await new Promise<never>(() => undefined);
          }
          return {};
        }),
        addNotificationHandler: vi.fn(() => () => undefined),
        addRequestHandler: vi.fn(() => () => undefined),
      };
      failedClient = c;
      return c as never;
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.spawnedBy = "agent:main:session-parent";
    params.timeoutMs = 1;

    await expect(runCodexAppServerAttempt(params, { startupTimeoutFloorMs: 1 })).rejects.toThrow(
      "codex app-server startup timed out",
    );
    const calledWithFailedClient = clearSpy.mock.calls.some(([arg]) => arg === failedClient);
    expect(calledWithFailedClient).toBe(true);
    clearSpy.mockRestore();
  });

  it("retires the shared Codex client when a spawned helper hits a thread/start write failure", async () => {
    const clearSpy = vi.spyOn(sharedClientModule, "clearSharedCodexAppServerClientIfCurrent");
    clearSpy.mockClear();
    let failedClient: unknown;
    setCodexAppServerClientFactoryForTest(async () => {
      const c = {
        request: vi.fn(async (method: string) => {
          if (method === "thread/start") {
            throw new Error("write EPIPE");
          }
          return {};
        }),
        addNotificationHandler: vi.fn(() => () => undefined),
        addRequestHandler: vi.fn(() => () => undefined),
      };
      failedClient = c;
      return c as never;
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.spawnedBy = "agent:main:session-parent";

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("write EPIPE");
    const calledWithFailedClient = clearSpy.mock.calls.some(([arg]) => arg === failedClient);
    expect(calledWithFailedClient).toBe(true);
    clearSpy.mockRestore();
  });

  it("retires the shared Codex client when a top-level run fails with a logical thread/start error", async () => {
    const clearSpy = vi.spyOn(sharedClientModule, "clearSharedCodexAppServerClientIfCurrent");
    clearSpy.mockClear();
    let failedClient: unknown;
    setCodexAppServerClientFactoryForTest(async () => {
      const c = {
        request: vi.fn(async (method: string) => {
          if (method === "thread/start") {
            throw new CodexAppServerRpcError(
              { message: "401 authentication_error: Invalid bearer token" },
              "thread/start",
            );
          }
          return {};
        }),
        addNotificationHandler: vi.fn(() => () => undefined),
        addRequestHandler: vi.fn(() => () => undefined),
      };
      failedClient = c;
      return c as never;
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("Invalid bearer token");
    const calledWithFailedClient = clearSpy.mock.calls.some(([arg]) => arg === failedClient);
    expect(calledWithFailedClient).toBe(true);
    clearSpy.mockRestore();
  });

  it("passes configured app-server policy, sandbox, service tier, and model on resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          approvalPolicy: "on-request",
          approvalsReviewer: "guardian_subagent",
          sandbox: "danger-full-access",
          serviceTier: "fast",
        },
      },
    });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expectResumeRequest(requests, {
      threadId: "thread-existing",
      model: "gpt-5.4-codex",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandbox: "danger-full-access",
      serviceTier: "priority",
      persistExtendedHistory: true,
    });
    const resumeRequest = requests.find((request) => request.method === "thread/resume");
    const resumeRequestParams = resumeRequest?.params as Record<string, unknown> | undefined;
    const resumeConfig = resumeRequestParams?.config as Record<string, unknown> | undefined;
    expect(resumeConfig?.["features.hooks"]).toBe(true);
    expect(resumeConfig?.["features.code_mode"]).toBe(true);
    expect(resumeConfig?.["features.code_mode_only"]).toBe(false);
    expect(resumeConfig?.["features.apply_patch_streaming_events"]).toBe(true);
    expect(resumeRequestParams?.developerInstructions).not.toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    const turnRequest = requests.find((request) => request.method === "turn/start");
    const turnRequestParams = turnRequest?.params as Record<string, unknown> | undefined;
    expect(turnRequestParams?.approvalPolicy).toBe("on-request");
    expect(turnRequestParams?.approvalsReviewer).toBe("guardian_subagent");
    expect(turnRequestParams?.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turnRequestParams?.serviceTier).toBe("priority");
    expect(turnRequestParams?.model).toBe("gpt-5.4-codex");
  });

  it("passes current Codex service tier request values through app-server resume and turn requests", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
          serviceTier: "priority",
        },
      },
    });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    const resumeRequest = requests.find((request) => request.method === "thread/resume");
    const resumeRequestParams = resumeRequest?.params as Record<string, unknown> | undefined;
    expect(resumeRequestParams?.serviceTier).toBe("priority");
    const turnRequest = requests.find((request) => request.method === "turn/start");
    const turnRequestParams = turnRequest?.params as Record<string, unknown> | undefined;
    expect(turnRequestParams?.serviceTier).toBe("priority");
  });

  it("reuses the bound auth profile for app-server startup when params omit it", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai-codex:bound",
      dynamicToolsFingerprint: "[]",
    });
    const seenAuthProfileIds: Array<string | undefined> = [];
    const seenAgentDirs: Array<string | undefined> = [];
    const { requests, waitForMethod, completeTurn } = createAppServerHarness(
      async (method: string) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        if (method === "turn/start") {
          return turnStartResult();
        }
        throw new Error(`unexpected method: ${method}`);
      },
      {
        onStart: (authProfileId, agentDir) => {
          seenAuthProfileIds.push(authProfileId);
          seenAgentDirs.push(agentDir);
        },
      },
    );
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;
    params.agentDir = path.join(tempDir, "agent");

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(seenAuthProfileIds).toEqual(["openai-codex:bound"]), {
      interval: 1,
    });
    await waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expect(seenAuthProfileIds).toEqual(["openai-codex:bound"]);
    expect(seenAgentDirs).toEqual([path.join(tempDir, "agent")]);
    expect(requests.map((entry) => entry.method)).toContain("turn/start");
  });
});
