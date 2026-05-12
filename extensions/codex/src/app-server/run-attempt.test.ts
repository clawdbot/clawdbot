import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  abortAgentHarnessRun,
  embeddedAgentLog,
  nativeHookRelayTesting,
  onAgentEvent,
  queueAgentHarnessMessage,
  resetAgentEventsForTest,
  type AgentEventPayload,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function queueActiveRunMessageForTest(
  ...args: Parameters<typeof queueAgentHarnessMessage>
): boolean {
  return queueAgentHarnessMessage(...args);
}
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "../../prompt-overlay.js";
import {
  buildCodexAppInventoryCacheKey,
  defaultCodexAppInventoryCache,
} from "./app-inventory-cache.js";
import {
  resolveCodexAppServerEnvApiKeyCacheKey,
  resolveCodexAppServerHomeDir,
} from "./auth-bridge.js";
import { readCodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import {
  CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
  createCodexDynamicToolBridge,
} from "./dynamic-tools.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import type { CodexServerNotification } from "./protocol.js";
import { rememberCodexRateLimits, resetCodexRateLimitCacheForTests } from "./rate-limit-cache.js";
import { runCodexAppServerAttempt, __testing } from "./run-attempt.js";
import { readCodexAppServerBinding, writeCodexAppServerBinding } from "./session-binding.js";
import { createCodexTestModel } from "./test-support.js";
import {
  buildTurnCollaborationMode,
  buildThreadResumeParams,
  buildTurnStartParams,
  startOrResumeThread,
} from "./thread-lifecycle.js";

let tempDir: string;

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

function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir || "/tmp/openclaw-codex-test",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: tempDir || "/tmp/openclaw-codex-test",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(turnId = "turn-1", status = "inProgress") {
  return {
    turn: {
      id: turnId,
      status,
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function rateLimitsUpdated(resetsAt: number): CodexServerNotification {
  return {
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
    },
  };
}

function assistantMessage(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

function userMessage(text: string, timestamp: number) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  };
}

function createAppServerHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown>,
  options: {
    onStart?: (authProfileId: string | undefined, agentDir: string | undefined) => void;
  } = {},
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
  let handleServerRequest: AppServerRequestHandler | undefined;
  const request = vi.fn(async (method: string, params?: unknown) => {
    requests.push({ method, params });
    return requestImpl(method, params);
  });

  __testing.setCodexAppServerClientFactoryForTests(
    async (_startOptions, authProfileId, agentDir) => {
      options.onStart?.(authProfileId, agentDir);
      return {
        request,
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: (handler: AppServerRequestHandler) => {
          handleServerRequest = handler;
          return () => undefined;
        },
      } as never;
    },
  );

  const waitForServerRequestHandler = async () => {
    await vi.waitFor(() => expect(handleServerRequest).toBeTypeOf("function"), {
      interval: 1,
      timeout: 30_000,
    });
    return handleServerRequest!;
  };

  return {
    request,
    requests,
    async waitForMethod(method: string, timeoutMs = 30_000) {
      await vi.waitFor(
        () => {
          if (!requests.some((entry) => entry.method === method)) {
            const mockMethods = request.mock.calls.map((call) => call[0]);
            throw new Error(
              `expected app-server method ${method}; saw ${requests
                .map((entry) => entry.method)
                .join(", ")}; mock saw ${mockMethods.join(", ")}`,
            );
          }
        },
        { interval: 1, timeout: timeoutMs },
      );
    },
    async notify(notification: CodexServerNotification) {
      await notify(notification);
    },
    waitForServerRequestHandler,
    async handleServerRequest(request: Parameters<AppServerRequestHandler>[0]) {
      const handler = await waitForServerRequestHandler();
      return handler(request);
    },
    async completeTurn(params: { threadId: string; turnId: string }) {
      await notify({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: { id: params.turnId, status: "completed" },
        },
      });
    },
  };
}

function createStartedThreadHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown> = async () => undefined,
  options: {
    onStart?: (authProfileId: string | undefined, agentDir: string | undefined) => void;
  } = {},
) {
  return createAppServerHarness(async (method, params) => {
    const override = await requestImpl(method, params);
    if (override !== undefined) {
      return override;
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  }, options);
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

function createResumeHarness() {
  return createAppServerHarness(async (method) => {
    if (method === "thread/resume") {
      return threadStartResult("thread-existing");
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  });
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

function createRuntimeDynamicTool(name: string) {
  return {
    name,
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
  } as never;
}

function createPluginAppConfigPatch() {
  return {
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "google-calendar-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    },
  };
}

function createPluginAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-1",
    apps: {
      "google-calendar-app": {
        configKey: "google-calendar",
        marketplaceName: "openai-curated" as const,
        pluginName: "google-calendar",
        allowDestructiveActions: false,
        mcpServerNames: ["google-calendar"],
      },
    },
    pluginAppIds: {
      "google-calendar": ["google-calendar-app"],
    },
  };
}

function createTwoPluginAppConfigPatch() {
  return {
    apps: {
      ...createPluginAppConfigPatch().apps,
      "gmail-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    },
  };
}

function createTwoPluginAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-2",
    apps: {
      ...createPluginAppPolicyContext().apps,
      "gmail-app": {
        configKey: "gmail",
        marketplaceName: "openai-curated" as const,
        pluginName: "gmail",
        allowDestructiveActions: false,
        mcpServerNames: ["gmail"],
      },
    },
    pluginAppIds: {
      ...createPluginAppPolicyContext().pluginAppIds,
      gmail: ["gmail-app"],
    },
  };
}

function createTwoCalendarAppConfigPatch() {
  return {
    apps: {
      ...createPluginAppConfigPatch().apps,
      "google-calendar-secondary-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    },
  };
}

function createTwoCalendarAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-calendar-2",
    apps: {
      ...createPluginAppPolicyContext().apps,
      "google-calendar-secondary-app": {
        configKey: "google-calendar",
        marketplaceName: "openai-curated" as const,
        pluginName: "google-calendar",
        allowDestructiveActions: false,
        mcpServerNames: ["google-calendar"],
      },
    },
    pluginAppIds: {
      "google-calendar": ["google-calendar-app", "google-calendar-secondary-app"],
    },
  };
}

type AppServerRequestHandler = (request: {
  id: string | number;
  method: string;
  params?: unknown;
}) => Promise<unknown>;

function extractRelayIdFromThreadRequest(params: unknown): string {
  const config = (params as { config?: Record<string, unknown> }).config;
  let command: string | undefined;
  for (const key of [
    "hooks.PreToolUse",
    "hooks.PostToolUse",
    "hooks.PermissionRequest",
    "hooks.Stop",
  ]) {
    const entries = config?.[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries as Array<{ hooks?: Array<{ command?: string }> }>) {
      command = entry.hooks?.find((hook) => typeof hook.command === "string")?.command;
      if (command) {
        break;
      }
    }
    if (command) {
      break;
    }
  }
  const match = command?.match(/--relay-id ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay id missing from command: ${command}`);
  }
  return match[1];
}

describe("runCodexAppServerAttempt", () => {
  beforeEach(async () => {
    resetAgentEventsForTest();
    vi.stubEnv("OPENCLAW_TRAJECTORY", "0");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-"));
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    __testing.resetOpenClawCodingToolsFactoryForTests();
    resetCodexRateLimitCacheForTests();
    nativeHookRelayTesting.clearNativeHookRelaysForTests();
    resetAgentEventsForTest();
    resetGlobalHookRunner();
    defaultCodexAppInventoryCache.clear();
    vi.useRealTimers();
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
      "web_search",
      "message",
      "heartbeat_respond",
      "sessions_spawn",
    ].map((name) => ({ name }));

    expect(__testing.filterCodexDynamicTools(tools, {}).map((tool) => tool.name)).toEqual([
      "web_search",
      "message",
      "heartbeat_respond",
      "sessions_spawn",
    ]);
  });

  it("applies additional Codex dynamic tool excludes without exposing Codex-native tools", () => {
    const tools = ["read", "exec", "message", "custom_tool"].map((name) => ({ name }));

    expect(
      __testing
        .filterCodexDynamicTools(tools, {
          codexDynamicToolsExclude: ["custom_tool"],
        })
        .map((tool) => tool.name),
    ).toEqual(["message"]);
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
    const dynamicTools = __testing.filterCodexDynamicTools(
      [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "update_plan",
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
    ]) {
      expect(dynamicToolNames).not.toContain(toolName);
    }
  });

  it("does not expose OpenClaw Tool Search controls through Codex dynamic tools", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.config = {
      tools: {
        toolSearch: true,
      },
    };
    const sandboxSessionKey = params.sessionKey;
    if (!sandboxSessionKey) {
      throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
    }

    const tools = await __testing.buildDynamicTools({
      params,
      resolvedWorkspace: workspaceDir,
      effectiveWorkspace: workspaceDir,
      sandboxSessionKey,
      sandbox: null as never,
      runAbortController: new AbortController(),
      sessionAgentId: "main",
      pluginConfig: {},
      onYieldDetected: () => undefined,
    });
    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
      loading: "searchable",
    });
    const dynamicToolNames = bridge.specs.map((tool) => tool.name);

    for (const toolName of ["tool_search_code", "tool_search", "tool_describe", "tool_call"]) {
      expect(dynamicToolNames).not.toContain(toolName);
    }
  });

  it("normalizes Codex dynamic toolsAllow entries before filtering", () => {
    const tools = ["exec", "apply_patch", "read", "message"].map((name) => ({ name }));

    expect(
      __testing
        .filterCodexDynamicToolsForAllowlist(tools, [" BASH ", "apply-patch", "READ"])
        .map((tool) => tool.name),
    ).toEqual(["exec", "apply_patch", "read"]);
  });

  it("forces the message dynamic tool for message-tool-only source replies", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.sourceReplyDeliveryMode = "message_tool_only";

    expect(__testing.shouldForceMessageTool(params)).toBe(true);

    params.sourceReplyDeliveryMode = "automatic";
    expect(__testing.shouldForceMessageTool(params)).toBe(false);
  });

  it("starts Codex threads with searchable OpenClaw dynamic tools by default", async () => {
    __testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("web_search"),
      createRuntimeDynamicTool("heartbeat_respond"),
    ]);
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.toolsAllow = ["message", "web_search", "heartbeat_respond"];

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await harness.waitForMethod("turn/start", 120_000);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((entry) => entry.method === "thread/start");
    const dynamicTools =
      (startRequest?.params as { dynamicTools?: Array<Record<string, unknown>> } | undefined)
        ?.dynamicTools ?? [];
    const message = dynamicTools.find((tool) => tool.name === "message");
    const webSearch = dynamicTools.find((tool) => tool.name === "web_search");
    const heartbeat = dynamicTools.find((tool) => tool.name === "heartbeat_respond");

    expect(message).not.toHaveProperty("namespace");
    expect(message).not.toHaveProperty("deferLoading");
    expect(webSearch?.namespace).toBe(CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE);
    expect(webSearch?.deferLoading).toBe(true);
    expect(heartbeat?.namespace).toBe(CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE);
    expect(heartbeat?.deferLoading).toBe(true);
  });

  it("returns a run context report without deferred Codex dynamic tool schemas", async () => {
    __testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("message"),
      createRuntimeDynamicTool("web_search"),
    ]);
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.toolsAllow = ["message", "web_search"];

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await harness.waitForMethod("turn/start", 120_000);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    const report = result.systemPromptReport;
    expect(report?.source).toBe("run");
    expect(report?.provider).toBe("codex");
    expect(report?.model).toBe("gpt-5.4-codex");
    expect(report?.systemPrompt.chars).toBeGreaterThan(0);

    const message = report?.tools.entries.find((tool) => tool.name === "message");
    const webSearch = report?.tools.entries.find((tool) => tool.name === "web_search");
    expect(message?.schemaChars).toBeGreaterThan(0);
    expect(webSearch?.schemaChars).toBe(0);
    expect(report?.tools.schemaChars).toBe(message?.schemaChars);
  });

  it("keeps searchable Codex dynamic tools canonical in mirrored transcript snapshots", async () => {
    __testing.setOpenClawCodingToolsFactoryForTests(() => [
      createRuntimeDynamicTool("wiki_status"),
    ]);
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["wiki_status"];

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        codexDynamicToolsLoading: "searchable",
        appServer: { mode: "yolo" },
      },
    });
    await harness.waitForMethod("turn/start", 120_000);

    const toolResult = (await harness.handleServerRequest({
      id: "request-tool-wiki-status",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-wiki-status-1",
        namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
        tool: "wiki_status",
        arguments: { topic: "README.md" },
      },
    })) as {
      contentItems?: Array<{ text?: string; type?: string }>;
      success?: boolean;
    };
    expect(toolResult).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "wiki_status done" }],
    });

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

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

  it("passes the live run session key to Codex dynamic tools when sandbox policy uses another key", () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    params.sessionKey = "agent:main:main";

    expect(
      __testing.resolveOpenClawCodingToolsSessionKeys(
        params,
        "agent:main:telegram:default:direct:1234",
      ),
    ).toEqual({
      sessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: "agent:main:main",
    });

    expect(__testing.resolveOpenClawCodingToolsSessionKeys(params, "agent:main:main")).toEqual({
      sessionKey: "agent:main:main",
      runSessionKey: undefined,
    });
  });

  it("keeps explicit dynamic tool timeouts above the default bridge deadline", () => {
    const timeoutMs = __testing.CODEX_DYNAMIC_TOOL_TIMEOUT_MS + 1_000;

    expect(
      __testing.resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-long",
          namespace: null,
          tool: "image_generate",
          arguments: { prompt: "cat", timeoutMs },
        },
        config: undefined,
      }),
    ).toBe(timeoutMs);
  });

  it("uses configured image generation timeouts for Codex dynamic tool calls", () => {
    expect(
      __testing.resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-image-generate-default",
          namespace: null,
          tool: "image_generate",
          arguments: { prompt: "cat" },
        },
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
                timeoutMs: 180_000,
              },
            },
          },
        },
      }),
    ).toBe(180_000);
  });

  it("uses the media image timeout for Codex image dynamic tool calls", () => {
    expect(
      __testing.resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-image-default",
          namespace: null,
          tool: "image",
          arguments: { prompt: "describe", images: ["/tmp/one.jpg"] },
        },
        config: {
          tools: {
            media: {
              image: {
                timeoutSeconds: 180,
              },
            },
          },
        },
      }),
    ).toBe(180_000);
  });

  it("keeps Codex image dynamic tool calls above the default bridge deadline", () => {
    expect(
      __testing.resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-image-default",
          namespace: null,
          tool: "image",
          arguments: { prompt: "describe", images: ["/tmp/one.jpg"] },
        },
        config: undefined,
      }),
    ).toBe(__testing.CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS);
  });

  it("caps dynamic tool timeouts at the bridge maximum", () => {
    expect(
      __testing.resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-too-long",
          namespace: null,
          tool: "image_generate",
          arguments: {
            prompt: "cat",
            timeoutMs: __testing.CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS + 1_000,
          },
        },
        config: undefined,
      }),
    ).toBe(__testing.CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS);
  });

  it("returns a failed dynamic tool response when an app-server tool call exceeds the deadline", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const onTimeout = vi.fn();
    const response = __testing.handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-timeout",
        namespace: null,
        tool: "message",
        arguments: { action: "send", text: "hello" },
      },
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          capturedSignal = options?.signal;
          return new Promise<never>(() => undefined);
        }),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw dynamic tool call timed out after 1ms while running tool message.",
        },
      ],
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("logs process poll timeout context separately from session idle", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const response = __testing.handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-timeout",
        namespace: null,
        tool: "process",
        arguments: { action: "poll", sessionId: "rapid-crustacean", timeout: 30_000 },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => undefined)),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw dynamic tool call timed out after 1ms while waiting for process action=poll sessionId=rapid-crustacean. This is a tool RPC timeout, not a session idle timeout.",
        },
      ],
    });
    expect(warn).toHaveBeenCalledWith("codex dynamic tool call timed out", {
      tool: "process",
      toolCallId: "call-timeout",
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 1,
      timeoutKind: "codex_dynamic_tool_rpc",
      processAction: "poll",
      processSessionId: "rapid-crustacean",
      processRequestedTimeoutMs: 30_000,
      consoleMessage:
        "codex process tool timeout: action=poll sessionId=rapid-crustacean toolTimeoutMs=1 requestedWaitMs=30000; per-tool-call watchdog, not session idle; repeated lines usually mean process-poll retry churn, not model progress",
    });
  });

  it("emits normalized tool progress around app-server dynamic tool requests", async () => {
    const harness = createStartedThreadHarness();
    const onRunAgentEvent = vi.fn();
    const onExecutionPhase = vi.fn();
    const globalAgentEvents: AgentEventPayload[] = [];
    onAgentEvent((event) => globalAgentEvents.push(event));
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onAgentEvent = onRunAgentEvent;
    params.onExecutionPhase = onExecutionPhase;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const toolResult = (await harness.handleServerRequest({
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "message",
        arguments: {
          action: "send",
          token: "plain-secret-value-12345",
          text: "hello",
        },
      },
    })) as {
      contentItems?: Array<{ text?: string; type?: string }>;
      success?: boolean;
    };
    expect(toolResult.success).toBe(false);
    expect(toolResult.contentItems?.[0]?.type).toBe("inputText");
    expect(toolResult.contentItems?.[0]?.text).toMatch(
      /^(Unknown OpenClaw tool: message|Action send requires a target\.)$/u,
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data?: {
        args?: Record<string, unknown>;
        isError?: boolean;
        name?: string;
        phase?: string;
        result?: { success?: boolean };
        toolCallId?: string;
      };
      stream?: string;
    }>;
    const startEvent = agentEvents.find(
      (event) => event.stream === "tool" && event.data?.phase === "start",
    );
    expect(startEvent?.data?.name).toBe("message");
    expect(startEvent?.data?.toolCallId).toBe("call-1");
    expect(startEvent?.data?.args?.action).toBe("send");
    expect(startEvent?.data?.args?.token).toBe("plain-…2345");
    expect(startEvent?.data?.args?.text).toBe("hello");
    const resultEvent = agentEvents.find(
      (event) => event.stream === "tool" && event.data?.phase === "result",
    );
    expect(resultEvent?.data?.name).toBe("message");
    expect(resultEvent?.data?.toolCallId).toBe("call-1");
    expect(resultEvent?.data?.isError).toBe(true);
    expect(resultEvent?.data?.result?.success).toBe(false);
    expect(JSON.stringify(agentEvents)).not.toContain("plain-secret-value-12345");
    const globalStartEvent = globalAgentEvents.find(
      (event) => event.stream === "tool" && event.data.phase === "start",
    );
    expect(globalStartEvent?.runId).toBe("run-1");
    expect(globalStartEvent?.sessionKey).toBe("agent:main:session-1");
    expect(globalStartEvent?.data.name).toBe("message");
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "turn_accepted",
      provider: "codex",
      model: "gpt-5.4-codex",
      backend: "codex-app-server",
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      provider: "codex",
      model: "gpt-5.4-codex",
      backend: "codex-app-server",
      tool: "message",
      toolCallId: "call-1",
    });
  });

  it("releases the session when Codex never completes after a dynamic tool response", async () => {
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: () => () => undefined,
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { turnCompletionIdleTimeoutMs: 5 } },
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), { interval: 1 });

    const toolResult = (await handleRequest?.({
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "message",
        arguments: { action: "send", text: "already sent" },
      },
    })) as {
      contentItems?: Array<{ text?: string; type?: string }>;
      success?: boolean;
    };
    expect(toolResult.success).toBe(false);
    expect(toolResult.contentItems?.[0]?.type).toBe("inputText");
    expect(toolResult.contentItems?.[0]?.text).toMatch(
      /^(Unknown OpenClaw tool: message|Action send requires a target\.)$/u,
    );

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
    expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
  });

  it("closes the app-server client when the active turn exceeds the attempt timeout", async () => {
    const close = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      if (method === "turn/interrupt") {
        return new Promise<never>(() => undefined);
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          close,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 100;

    const result = await runCodexAppServerAttempt(params);

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe("codex app-server attempt timed out");
    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      {
        threadId: "thread-1",
        turnId: "turn-1",
      },
      { timeoutMs: 5_000 },
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
  });

  it("does not count account rate-limit updates as turn completion activity", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), { interval: 1 });

    const toolResult = (await handleRequest?.({
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "message",
        arguments: { action: "send", text: "already sent" },
      },
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify(rateLimitsUpdated(Math.ceil(Date.now() / 1000) + 120));

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const warnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for completion",
    );
    const warnData = warnCall?.[1] as
      | { lastActivityReason?: string; timeoutMs?: number }
      | undefined;
    expect(warnData?.timeoutMs).toBe(5);
    expect(warnData?.lastActivityReason).toBe("request:item/tool/call:response");
  });

  it("keeps waiting when Codex emits a raw assistant item after a dynamic tool response", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 200,
      turnTerminalIdleTimeoutMs: 200,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), { interval: 1 });

    const toolResult = (await handleRequest?.({
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "message",
        arguments: { action: "send", text: "already sent" },
      },
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing the report now." }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("logs raw assistant item context when the terminal watchdog fires", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
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
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, {
      turnCompletionIdleTimeoutMs: 5,
      turnAssistantCompletionIdleTimeoutMs: 500,
      turnTerminalIdleTimeoutMs: 5,
    });
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), { interval: 1 });

    const toolResult = (await handleRequest?.({
      id: "request-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "message",
        arguments: { action: "send", text: "already sent" },
      },
    })) as { success?: boolean };
    expect(toolResult.success).toBe(false);
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-status-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm writing the report now." }],
        },
      },
    });

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    const terminalWarnCall = warn.mock.calls.find(
      ([message]) => message === "codex app-server turn idle timed out waiting for terminal event",
    );
    const terminalWarnData = terminalWarnCall?.[1] as
      | {
          lastActivityReason?: string;
          lastAssistantTextPreview?: string;
          lastNotificationItemId?: string;
          lastNotificationItemRole?: string;
          lastNotificationItemType?: string;
          lastNotificationMethod?: string;
          threadId?: string;
          timeoutMs?: number;
          turnId?: string;
        }
      | undefined;
    expect(terminalWarnData?.threadId).toBe("thread-1");
    expect(terminalWarnData?.turnId).toBe("turn-1");
    expect(terminalWarnData?.timeoutMs).toBe(5);
    expect(terminalWarnData?.lastActivityReason).toBe("notification:rawResponseItem/completed");
    expect(terminalWarnData?.lastNotificationMethod).toBe("rawResponseItem/completed");
    expect(terminalWarnData?.lastNotificationItemId).toBe("raw-status-1");
    expect(terminalWarnData?.lastNotificationItemType).toBe("message");
    expect(terminalWarnData?.lastNotificationItemRole).toBe("assistant");
    expect(terminalWarnData?.lastAssistantTextPreview).toBe("I'm writing the report now.");
    expect(
      warn.mock.calls.some(
        ([message]) => message === "codex app-server turn idle timed out waiting for completion",
      ),
    ).toBe(false);
  });

  it("releases the session when Codex accepts a turn but never sends progress", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 60_000;

    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 5 });
    await harness.waitForMethod("turn/start");

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBe(
      "codex app-server turn idle timed out waiting for turn/completed",
    );
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
    expect(queueActiveRunMessageForTest("session-1", "after silent turn")).toBe(false);
  });

  it("does not treat global rate-limit notifications as turn progress", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 15 });
    await harness.waitForMethod("turn/start");
    await harness.notify(rateLimitsUpdated(Date.now() + 60_000));
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(run).resolves.toMatchObject({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server turn idle timed out waiting for turn/completed",
    });
    await vi.waitFor(
      () =>
        expect(harness.request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it("releases the session when a completed agent message item goes quiet", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
          text: "Done.",
        },
      },
    });

    await expect(run).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it("releases the session when a real completed agent message omits text", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-final-1",
        delta: "Done.",
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
        },
      },
    });

    await expect(run).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it("keeps the completed assistant release armed across bookkeeping notifications", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-final-1",
        delta: "Done.",
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
        },
      },
    });
    await notify({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        plan: [],
      },
    });

    await expect(run).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith(
          "turn/interrupt",
          {
            threadId: "thread-1",
            turnId: "turn-1",
          },
          { timeoutMs: 5_000 },
        ),
      { interval: 1 },
    );
  });

  it("does not release commentary agent message items", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-commentary-1",
          phase: "commentary",
          text: "I am checking the workspace.",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
          phase: "final_answer",
          text: "Done.",
        },
      },
    });

    await expect(run).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
  });

  it("does not release the session after only a raw assistant response item", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 15,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "raw-final-1",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(run).resolves.toMatchObject({
      aborted: true,
      timedOut: true,
      promptError: "codex app-server turn idle timed out waiting for turn/completed",
    });
  });

  it("keeps waiting when a current-turn item is still active", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 200;

    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 50,
    });
    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), expect.anything()),
      { interval: 1 },
    );
    await notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "cmd-1", status: "inProgress" },
      },
    });
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-final-1",
          text: "Done.",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "cmd-1", status: "completed" },
      },
    });

    await expect(run).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done."],
    });
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
    const [hookInput, hookContext] = beforePromptBuild.mock.calls[0] as unknown as [
      { messages?: Array<{ role?: string }>; prompt?: string },
      { runId?: string; sessionId?: string },
    ];
    expect(hookInput.prompt).toBe("hello");
    expect(hookInput.messages?.[0]?.role).toBe("assistant");
    expect(hookContext.runId).toBe("run-1");
    expect(hookContext.sessionId).toBe("session-1");
    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as { developerInstructions?: string } | undefined;
    expect(threadStartParams?.developerInstructions).toContain("pre system\n\ncustom codex system");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as
      | { input?: Array<{ text?: string; text_elements?: unknown[]; type?: string }> }
      | undefined;
    expect(turnStartParams?.input).toEqual([
      { type: "text", text: "queued context\n\nhello", text_elements: [] },
    ]);
  });

  it("projects mirrored history when starting Codex without a native thread binding", async () => {
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

    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("we are fixing the Opik default project");
    expect(inputText).toContain("Opik default project context");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("make the default webpage openclaw");
  });

  it("passes OpenClaw bootstrap files through Codex developer instructions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const params = threadStart?.params as {
      config?: { instructions?: string };
      developerInstructions?: string;
    };
    const config = params.config;

    // Regression for #77363: persona/style bootstrap (SOUL.md) must reach the
    // explicit developerInstructions field, not config.instructions.
    expect(params.developerInstructions).toContain("Soul voice goes here.");
    expect(params.developerInstructions).toContain("Codex loads AGENTS.md natively");
    expect(params.developerInstructions).not.toContain("Follow AGENTS guidance.");
    expect(config?.instructions).toBeUndefined();
  });

  it("fires llm_input, llm_output, and agent_end hooks for codex turns", async () => {
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    const onRunAgentEvent = vi.fn();
    const globalAgentEvents: AgentEventPayload[] = [];
    onAgentEvent((event) => globalAgentEvents.push(event));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(assistantMessage("existing context", Date.now()));
    const harness = createStartedThreadHarness();

    const params = createParams(sessionFile, workspaceDir);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    expect(llmInput).toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const [llmInputPayload, llmInputContext] = llmInput.mock.calls[0] as unknown as [
      {
        historyMessages?: Array<{ role?: string }>;
        imagesCount?: number;
        model?: string;
        prompt?: string;
        provider?: string;
        runId?: string;
        sessionId?: string;
        systemPrompt?: string;
      },
      { runId?: string; sessionId?: string; sessionKey?: string },
    ];
    expect(llmInputPayload.runId).toBe("run-1");
    expect(llmInputPayload.sessionId).toBe("session-1");
    expect(llmInputPayload.provider).toBe("codex");
    expect(llmInputPayload.model).toBe("gpt-5.4-codex");
    expect(llmInputPayload.prompt).toBe("hello");
    expect(llmInputPayload.imagesCount).toBe(0);
    expect(llmInputPayload.historyMessages?.[0]?.role).toBe("assistant");
    expect(llmInputPayload.systemPrompt).toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    expect(llmInputContext.runId).toBe("run-1");
    expect(llmInputContext.sessionId).toBe("session-1");
    expect(llmInputContext.sessionKey).toBe("agent:main:session-1");

    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-1",
        delta: "hello back",
      },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(result.assistantTexts).toEqual(["hello back"]);
    expect(llmOutput).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data: {
        endedAt?: number;
        phase?: string;
        startedAt?: number;
        text?: string;
      };
      stream: string;
    }>;
    const lifecycleStart = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    expect(typeof lifecycleStart?.data.startedAt).toBe("number");
    const assistantEvent = agentEvents.find((event) => event.stream === "assistant");
    expect(assistantEvent?.data).toEqual({ text: "hello back" });
    const lifecycleEnd = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(typeof lifecycleEnd?.data.startedAt).toBe("number");
    expect(typeof lifecycleEnd?.data.endedAt).toBe("number");
    const startIndex = agentEvents.findIndex(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    const assistantIndex = agentEvents.findIndex((event) => event.stream === "assistant");
    const endIndex = agentEvents.findIndex(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(startIndex);
    expect(endIndex).toBeGreaterThan(assistantIndex);
    const globalAssistantEvent = globalAgentEvents.find((event) => event.stream === "assistant");
    expect(globalAssistantEvent?.runId).toBe("run-1");
    expect(globalAssistantEvent?.sessionKey).toBe("agent:main:session-1");
    expect(globalAssistantEvent?.data).toEqual({ text: "hello back" });
    const globalEndEvent = globalAgentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(globalEndEvent?.runId).toBe("run-1");
    expect(globalEndEvent?.sessionKey).toBe("agent:main:session-1");

    const [llmOutputPayload, llmOutputContext] = llmOutput.mock.calls[0] as unknown as [
      {
        assistantTexts?: string[];
        harnessId?: string;
        lastAssistant?: { role?: string };
        model?: string;
        provider?: string;
        resolvedRef?: string;
        runId?: string;
        sessionId?: string;
      },
      { runId?: string; sessionId?: string },
    ];
    expect(llmOutputPayload.runId).toBe("run-1");
    expect(llmOutputPayload.sessionId).toBe("session-1");
    expect(llmOutputPayload.provider).toBe("codex");
    expect(llmOutputPayload.model).toBe("gpt-5.4-codex");
    expect(llmOutputPayload.resolvedRef).toBe("codex/gpt-5.4-codex");
    expect(llmOutputPayload.harnessId).toBe("codex");
    expect(llmOutputPayload.assistantTexts).toEqual(["hello back"]);
    expect(llmOutputPayload.lastAssistant?.role).toBe("assistant");
    expect(llmOutputContext.runId).toBe("run-1");
    expect(llmOutputContext.sessionId).toBe("session-1");
    const [agentEndPayload, agentEndContext] = agentEnd.mock.calls[0] as unknown as [
      { messages?: Array<{ role?: string }>; success?: boolean },
      { runId?: string; sessionId?: string },
    ];
    expect(agentEndPayload.success).toBe(true);
    expect(agentEndPayload.messages?.some((message) => message.role === "user")).toBe(true);
    expect(agentEndPayload.messages?.some((message) => message.role === "assistant")).toBe(true);
    expect(agentEndContext.runId).toBe("run-1");
    expect(agentEndContext.sessionId).toBe("session-1");
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

  it("registers native hook relay config for an enabled Codex turn and cleans it up", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
        gatewayTimeoutMs: 4321,
        hookTimeoutSec: 9,
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.codex_hooks"]).toBe(true);
    const preToolUseHooks = startConfig?.["hooks.PreToolUse"] as
      | Array<{ hooks?: Array<{ command?: string; timeout?: number; type?: string }> }>
      | undefined;
    const preToolUseCommand = preToolUseHooks?.[0]?.hooks?.[0];
    expect(preToolUseCommand?.type).toBe("command");
    expect(preToolUseCommand?.timeout).toBe(9);
    expect(preToolUseCommand?.command).toContain("--event pre_tool_use --timeout 4321");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("keeps the native hook relay default floor for short Codex turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const relayFloorMs = 30 * 60_000;

    const startedAtMs = Date.now();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    expect(registration.expiresAtMs - startedAtMs).toBeGreaterThanOrEqual(relayFloorMs);
    expect(registration.expiresAtMs - startedAtMs).toBeLessThan(relayFloorMs + 10_000);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("preserves an explicit native hook relay ttl", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const explicitTtlMs = 123_456;

    const startedAtMs = Date.now();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
        ttlMs: explicitTtlMs,
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    expect(registration.expiresAtMs - startedAtMs).toBeGreaterThanOrEqual(explicitTtlMs);
    expect(registration.expiresAtMs - startedAtMs).toBeLessThan(explicitTtlMs + 10_000);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("lets Codex app-server approval modes own native permission requests by default", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.codex_hooks"]).toBe(true);
    expect(Array.isArray(startConfig?.["hooks.PreToolUse"])).toBe(true);
    expect(Array.isArray(startConfig?.["hooks.PostToolUse"])).toBe(true);
    expect(Array.isArray(startConfig?.["hooks.Stop"])).toBe(true);
    expect(startConfig).not.toHaveProperty("hooks.PermissionRequest");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.allowedEvents,
    ).toEqual(["pre_tool_use", "post_tool_use", "before_agent_finalize"]);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("preserves explicit native permission request relay events in app-server approval modes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      nativeHookRelay: {
        enabled: true,
        events: ["permission_request"],
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.codex_hooks"]).toBe(true);
    expect(Array.isArray(startConfig?.["hooks.PermissionRequest"])).toBe(true);
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.allowedEvents,
    ).toEqual(["permission_request"]);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("keeps native hook relays alive across startup and long Codex turn timeouts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    const abortController = new AbortController();
    const attemptTimeoutMs = 45 * 60_000;
    const startupTimeoutMs = attemptTimeoutMs;
    const turnStartTimeoutMs = attemptTimeoutMs;
    const cleanupGraceMs = 5 * 60_000;
    const expectedRelayTtlMs =
      attemptTimeoutMs + startupTimeoutMs + turnStartTimeoutMs + cleanupGraceMs;
    params.timeoutMs = attemptTimeoutMs;
    params.abortSignal = abortController.signal;

    const startedAtMs = Date.now();
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    let completed = false;
    let relayId: string | undefined;
    try {
      await harness.waitForMethod("turn/start");

      const startRequest = harness.requests.find((request) => request.method === "thread/start");
      relayId = extractRelayIdFromThreadRequest(startRequest?.params);
      const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
      if (!registration) {
        throw new Error("Expected native hook relay registration");
      }
      expect(registration.expiresAtMs - startedAtMs).toBeGreaterThanOrEqual(expectedRelayTtlMs);

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      completed = true;
      await run;
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
      ).toBeUndefined();
    } finally {
      if (!completed) {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" }).catch(() => {});
        abortController.abort(new Error("test cleanup"));
        await run.catch(() => {});
      }
    }
  });

  it("reuses the Codex native hook relay id across runs for the same session", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const firstHarness = createStartedThreadHarness();

    const firstRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await firstHarness.waitForMethod("turn/start");
    await firstHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;

    const firstStartRequest = firstHarness.requests.find(
      (request) => request.method === "thread/start",
    );
    const firstRelayId = extractRelayIdFromThreadRequest(firstStartRequest?.params);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId),
    ).toBeUndefined();

    const secondHarness = createResumeHarness();
    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.runId = "run-2";
    const secondRun = runCodexAppServerAttempt(secondParams, {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await secondHarness.waitForMethod("turn/start");

    const resumeRequest = secondHarness.requests.find(
      (request) => request.method === "thread/resume",
    );
    const secondRelayId = extractRelayIdFromThreadRequest(resumeRequest?.params);
    expect(secondRelayId).toBe(firstRelayId);
    const resumedRegistration =
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId);
    expect(resumedRegistration?.runId).toBe("run-2");
    expect(resumedRegistration?.allowedEvents).toEqual(["pre_tool_use"]);

    await secondHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await secondRun;
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId),
    ).toBeUndefined();
  });

  it("builds deterministic opaque Codex native hook relay ids", () => {
    const relayId = __testing.buildCodexNativeHookRelayId({
      agentId: "dev-codex",
      sessionId: "cu-pr-relay-smoke",
      sessionKey: "agent:dev-codex:cu-pr-relay-smoke",
    });

    expect(relayId).toBe("codex-8810b5252975550c887ff0def512b25e944bac39");
    expect(relayId).not.toContain("dev-codex");
    expect(relayId).not.toContain("cu-pr-relay-smoke");
  });

  it("sends clearing Codex native hook config when the relay is disabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: false },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.codex_hooks"]).toBe(false);
    expect(startConfig?.["hooks.PreToolUse"]).toEqual([]);
    expect(startConfig?.["hooks.PostToolUse"]).toEqual([]);
    expect(startConfig?.["hooks.PermissionRequest"]).toEqual([]);
    expect(startConfig?.["hooks.Stop"]).toEqual([]);
  });

  it("cleans up native hook relay state when turn/start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        nativeHookRelay: { enabled: true },
      }),
    ).rejects.toThrow("turn start exploded");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("preserves Codex usage-limit reset details when turn/start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai-codex:work";
    const harnessRef: { current?: ReturnType<typeof createStartedThreadHarness> } = {};
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        if (!harnessRef.current) {
          throw new Error("Expected Codex app-server harness to be initialized");
        }
        await harnessRef.current.notify(rateLimitsUpdated(resetsAt));
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });
    harnessRef.current = harness;

    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const result = await runCodexAppServerAttempt(params);
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
  });

  it("uses a recent Codex rate-limit snapshot when turn/start omits reset details", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const authProfileId = "openai-codex:work";
    rememberCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
      rateLimitsByLimitId: null,
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      return undefined;
    });

    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = authProfileId;
    params.authProfileStore = {
      version: 1,
      profiles: {
        [authProfileId]: {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const result = await run;
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
    expect(params.authProfileStore.usageStats?.[authProfileId]?.blockedUntil).toBeUndefined();
  });

  it("refreshes Codex account rate limits when turn/start omits reset details", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw Object.assign(new Error("You've reached your usage limit."), {
          data: { codexErrorInfo: "usageLimitExceeded" },
        });
      }
      if (method === "account/rateLimits/read") {
        return rateLimitsUpdated(resetsAt).params;
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("account/rateLimits/read");

    const result = await run;
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
    expect(result.promptError).not.toContain("Codex did not return a reset time");
  });

  it("cleans up native hook relay state when the Codex turn aborts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true },
    });
    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(abortAgentHarnessRun("session-1")).toBe(true);

    const result = await run;

    expect(result.aborted).toBe(true);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("refreshes Codex account rate limits when a failed turn omits reset details", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "account/rateLimits/read") {
        return rateLimitsUpdated(resetsAt).params;
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
          },
        },
      },
    });

    const result = await run;

    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
    expect(result.promptError).not.toContain("Codex did not return a reset time");
    expect(harness.requests.some((request) => request.method === "account/rateLimits/read")).toBe(
      true,
    );
  });

  it("fires agent_end with failure metadata when the codex turn fails", async () => {
    const agentEnd = vi.fn();
    const onRunAgentEvent = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const params = createParams(sessionFile, workspaceDir);
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "codex exploded" },
        },
      },
    });

    const result = await run;

    expect(result.promptError).toBe("codex exploded");
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data: { endedAt?: number; error?: string; phase?: string; startedAt?: number };
      stream: string;
    }>;
    const startEvent = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    expect(typeof startEvent?.data.startedAt).toBe("number");
    const errorEvent = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "error",
    );
    expect(typeof errorEvent?.data.startedAt).toBe("number");
    expect(typeof errorEvent?.data.endedAt).toBe("number");
    expect(errorEvent?.data.error).toBe("codex exploded");
    expect(agentEvents.some((event) => event.stream === "assistant")).toBe(false);
    const [agentEndPayload, agentEndContext] = agentEnd.mock.calls[0] as unknown as [
      { error?: string; success?: boolean },
      { runId?: string; sessionId?: string },
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe("codex exploded");
    expect(agentEndContext.runId).toBe("run-1");
    expect(agentEndContext.sessionId).toBe("session-1");
  });

  it("fires llm_output and agent_end when turn/start fails", async () => {
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()),
    );
    createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });

    const params = createParams(sessionFile, workspaceDir);
    params.runtimePlan = createCodexRuntimePlanFixture();

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn start exploded");

    expect(llmInput).toHaveBeenCalledTimes(1);
    expect(llmOutput).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [llmOutputPayload] = llmOutput.mock.calls[0] as unknown as [
      {
        assistantTexts?: string[];
        harnessId?: string;
        model?: string;
        provider?: string;
        resolvedRef?: string;
        runId?: string;
        sessionId?: string;
      },
      unknown,
    ];
    expect(llmOutputPayload.assistantTexts).toEqual([]);
    expect(llmOutputPayload.model).toBe("gpt-5.4-codex");
    expect(llmOutputPayload.provider).toBe("codex");
    expect(llmOutputPayload.resolvedRef).toBe("codex/gpt-5.4-codex");
    expect(llmOutputPayload.harnessId).toBe("codex");
    expect(llmOutputPayload.runId).toBe("run-1");
    expect(llmOutputPayload.sessionId).toBe("session-1");
    const [agentEndPayload] = agentEnd.mock.calls[0] as unknown as [
      { error?: string; messages?: Array<{ role?: string }>; success?: boolean },
      unknown,
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe("turn start exploded");
    expect(agentEndPayload.messages?.some((message) => message.role === "assistant")).toBe(true);
    expect(agentEndPayload.messages?.some((message) => message.role === "user")).toBe(true);
  });

  it("fires agent_end with success false when the codex turn is aborted", async () => {
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const { waitForMethod } = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { pluginConfig: { appServer: { mode: "yolo" } } },
    );

    await waitForMethod("turn/start");
    expect(abortAgentHarnessRun("session-1")).toBe(true);

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [agentEndPayload] = agentEnd.mock.calls[0] as unknown as [{ success?: boolean }, unknown];
    expect(agentEndPayload.success).toBe(false);
  });

  it("forwards queued user input and aborts the active app-server turn", async () => {
    const { requests, waitForMethod } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { pluginConfig: { appServer: { mode: "yolo" } } },
    );
    await waitForMethod("turn/start");

    expect(queueActiveRunMessageForTest("session-1", "more context", { debounceMs: 1 })).toBe(true);
    await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain("turn/steer"), {
      interval: 1,
    });
    expect(abortAgentHarnessRun("session-1")).toBe(true);
    await vi.waitFor(
      () => expect(requests.map((entry) => entry.method)).toContain("turn/interrupt"),
      { interval: 1 },
    );

    const result = await run;
    expect(result.aborted).toBe(true);
    const threadStart = requests.find((entry) => entry.method === "thread/start");
    const threadStartParams = threadStart?.params as
      | {
          approvalPolicy?: string;
          approvalsReviewer?: string;
          developerInstructions?: string;
          model?: string;
          sandbox?: string;
        }
      | undefined;
    expect(threadStartParams?.model).toBe("gpt-5.4-codex");
    expect(threadStartParams?.approvalPolicy).toBe("never");
    expect(threadStartParams?.sandbox).toBe("danger-full-access");
    expect(threadStartParams?.approvalsReviewer).toBe("user");
    expect(threadStartParams?.developerInstructions).toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    const steer = requests.find((entry) => entry.method === "turn/steer");
    expect(steer?.params).toEqual({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "more context", text_elements: [] }],
    });
    const interrupt = requests.find((entry) => entry.method === "turn/interrupt");
    expect(interrupt?.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
  });

  it("batches default queued steering before sending turn/steer", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await waitForMethod("turn/start");

    expect(queueActiveRunMessageForTest("session-1", "first", { debounceMs: 5 })).toBe(true);
    expect(queueActiveRunMessageForTest("session-1", "second", { debounceMs: 5 })).toBe(true);

    await vi.waitFor(
      () =>
        expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [
                { type: "text", text: "first", text_elements: [] },
                { type: "text", text: "second", text_elements: [] },
              ],
            },
          },
        ]),
      { interval: 1 },
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("flushes pending default queued steering during normal turn cleanup", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await waitForMethod("turn/start");

    expect(queueActiveRunMessageForTest("session-1", "late steer", { debounceMs: 30_000 })).toBe(
      true,
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "late steer", text_elements: [] }],
        },
      },
    ]);
  });

  it("keeps legacy queue steering as separate turn/steer requests", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await waitForMethod("turn/start");

    expect(
      queueActiveRunMessageForTest("session-1", "first", { steeringMode: "one-at-a-time" }),
    ).toBe(true);
    expect(
      queueActiveRunMessageForTest("session-1", "second", { steeringMode: "one-at-a-time" }),
    ).toBe(true);

    await vi.waitFor(
      () =>
        expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [{ type: "text", text: "first", text_elements: [] }],
            },
          },
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [{ type: "text", text: "second", text_elements: [] }],
            },
          },
        ]),
      { interval: 1 },
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("routes request_user_input prompts through the active run follow-up queue", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
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

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onBlockReply = vi.fn();
    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () => expect(request.mock.calls.map(([method]) => method)).toContain("turn/start"),
      { interval: 1 },
    );
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), { interval: 1 });

    const response = handleRequest?.({
      id: "request-input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "ask-1",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1), { interval: 1 });
    expect(queueActiveRunMessageForTest("session-1", "2")).toBe(true);
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Deep"] } },
    });
    const requestCalls = request.mock.calls as unknown as Array<[string, unknown]>;
    expect(
      requestCalls.some(
        ([method, callParams]) =>
          method === "turn/steer" &&
          (callParams as { expectedTurnId?: string } | undefined)?.expectedTurnId === "turn-1",
      ),
    ).toBe(false);

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
    params.model = createCodexTestModel("codex", ["text", "image"]);
    params.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2UtYnl0ZXM=",
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
      { type: "image", url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" },
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

  it("releases completion when Codex raw-events an interrupted turn marker", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { turnTerminalIdleTimeoutMs: 60_000 },
    );
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "abort-marker-1",
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
            },
          ],
        },
      },
    });

    const result = await run;
    expect(resolved).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it("does not treat a user prompt containing the interrupted marker as terminal", async () => {
    const harness = createStartedThreadHarness();
    const markerPrompt =
      "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>";
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.prompt = markerPrompt;
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "user-prompt-1",
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: markerPrompt,
            },
          ],
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
          items: [{ type: "agentMessage", id: "msg-1", text: "It marks an interrupted turn." }],
        },
      },
    });

    const result = await run;
    expect(resolved).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.assistantTexts).toEqual(["It marks an interrupted turn."]);
  });

  it("releases completion when a projector callback throws during turn/completed", async () => {
    // Regression for openclaw/openclaw#67996: a throw inside the projector's
    // turn/completed handler must not strand resolveCompletion, otherwise the
    // gateway session lane stays locked and every follow-up message queues
    // behind a run that will never resolve.
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onAgentEvent = () => {
      throw new Error("downstream consumer exploded");
    };
    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() =>
      expect(request.mock.calls.map(([method]) => method)).toContain("turn/start"),
    );
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ id: "plan-1", type: "plan", text: "step one\nstep two" }],
        },
      },
    });
    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("routes MCP approval elicitations through the native bridge", async () => {
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
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
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
    );
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"));

    const result = await handleRequest?.({
      id: "request-elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps__github",
        mode: "form",
      },
    });

    expect(result).toEqual({
      action: "accept",
      content: { approve: true },
      _meta: null,
    });
    const [bridgeCall] = bridgeSpy.mock.calls[0] as unknown as [
      { threadId?: string; turnId?: string },
    ];
    expect(bridgeCall.threadId).toBe("thread-1");
    expect(bridgeCall.turnId).toBe("turn-1");

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
      key: buildCodexAppInventoryCacheKey({
        codexHome: resolveCodexAppServerHomeDir(agentDir),
        endpoint: __testing.resolveCodexPluginAppCacheEndpoint(appServer),
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
    __testing.setCodexAppServerClientFactoryForTests(
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
    const [bridgeCall] = bridgeSpy.mock.calls[0] as unknown as [
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
      key: buildCodexAppInventoryCacheKey({
        codexHome: resolveCodexAppServerHomeDir(agentDir),
        endpoint: __testing.resolveCodexPluginAppCacheEndpoint(appServer),
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
      key: buildCodexAppInventoryCacheKey({
        codexHome: resolveCodexAppServerHomeDir(agentDir),
        endpoint: __testing.resolveCodexPluginAppCacheEndpoint(appServer),
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
    __testing.setCodexAppServerClientFactoryForTests(() => new Promise<never>(() => undefined));
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
    __testing.setCodexAppServerClientFactoryForTests(
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

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn/start timed out");
    expect(queueActiveRunMessageForTest("session-1", "after timeout")).toBe(false);
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
    expect(resumeRequestParams?.developerInstructions).toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
  });

  it("resumes a bound Codex thread when only dynamic tool descriptions change", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        createMessageDynamicTool("Send and manage messages for the current Slack thread."),
      ],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        createMessageDynamicTool("Send and manage messages for the current Discord channel."),
      ],
      appServer,
    });

    expect(binding.threadId).toBe("thread-existing");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
  });

  it("resumes a bound Codex thread when dynamic tools are reordered", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("wiki_status"), createNamedDynamicTool("diffs")],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("diffs"), createNamedDynamicTool("wiki_status")],
      appServer,
    });

    expect(binding.threadId).toBe("thread-existing");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
  });

  it("keeps the previous dynamic tool fingerprint for transient no-tool maintenance turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let nextThread = 1;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-${nextThread++}`);
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-1");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createMessageDynamicTool("Send and manage messages.")],
      appServer,
    });
    const fingerprint = (await readCodexAppServerBinding(sessionFile))?.dynamicToolsFingerprint;
    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createMessageDynamicTool("Send and manage messages.")],
      appServer,
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.dynamicToolsFingerprint).toBe(fingerprint);
    expect(binding?.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
  });

  it("preserves the binding when the app-server closes during thread resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        throw new Error("codex app-server client is closed");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: createParams(sessionFile, workspaceDir),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer,
      }),
    ).rejects.toThrow("codex app-server client is closed");

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
  });

  it("restarts the app-server once when a shared client closes during startup", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const requests: string[][] = [];
    let starts = 0;
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    __testing.setCodexAppServerClientFactoryForTests(async () => {
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
    await vi.waitFor(() => expect(requests[1]).toContain("turn/start"), { interval: 1 });
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
    expect(requests).toEqual([["thread/resume"], ["thread/resume", "turn/start"]]);
  });

  it("tolerates a second app-server close while retrying startup", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const requests: string[][] = [];
    let starts = 0;
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    __testing.setCodexAppServerClientFactoryForTests(async () => {
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
    await vi.waitFor(() => expect(requests[2]).toContain("turn/start"), { interval: 1 });
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
      ["thread/resume", "turn/start"],
    ]);
  });

  it("passes native hook relay config on thread start and resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const config = {
      "features.codex_hooks": true,
      "hooks.PreToolUse": [],
    };
    const expectedConfig = {
      ...config,
      "features.code_mode": true,
      "features.code_mode_only": true,
    };

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config,
    });
    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config,
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
    expect(requestCalls[0]?.[1].config).toEqual(expectedConfig);
    expect(requestCalls[1]?.[1].config).toEqual(expectedConfig);
  });

  it("merges native hook relay config with plugin app config when starting a thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-plugins");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: createPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.codex_hooks": true, hooks: { PreToolUse: [] } },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      "features.codex_hooks": true,
      "features.code_mode": true,
      "features.code_mode_only": true,
      hooks: { PreToolUse: [] },
      ...createPluginAppConfigPatch(),
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-plugins");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("revalidates compatible plugin app bindings without resending app config", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-plugins");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: createPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.codex_hooks": true },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: buildPluginThreadConfig,
      },
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.codex_hooks": true },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildPluginThreadConfig,
      },
    });

    expect(binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(2);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      "features.codex_hooks": true,
      "features.code_mode": true,
      "features.code_mode_only": true,
      ...createPluginAppConfigPatch(),
    });
    expect(requestCalls[1]?.[1].config).toEqual({
      "features.codex_hooks": true,
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
  });

  it("starts a new plugin app thread when full binding revalidation removes an app", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: "plugin-apps-config-1",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext: createPluginAppPolicyContext(),
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-revalidated");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const emptyPolicyContext = { fingerprint: "plugin-policy-empty", apps: {}, pluginAppIds: {} };
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: {
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
      },
      fingerprint: "plugin-apps-empty",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: emptyPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-revalidated");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-empty");
    expect(binding?.pluginAppPolicyContext).toEqual(emptyPolicyContext);
  });

  it("keeps the existing plugin app binding when revalidation fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: "plugin-apps-config-1",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext,
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: async () => {
          throw new Error("plugin inventory unavailable");
        },
      },
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/resume"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-existing");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("rebuilds an empty plugin app binding after app inventory recovers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: "plugin-apps-empty",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext: { fingerprint: "plugin-policy-empty", apps: {}, pluginAppIds: {} },
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-recovered");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: createPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      ...createPluginAppConfigPatch(),
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-recovered");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("keeps an empty plugin app binding when recovery still produces the same config", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const emptyPolicyContext = { fingerprint: "plugin-policy-empty", apps: {}, pluginAppIds: {} };
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: "plugin-apps-empty",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext: emptyPolicyContext,
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: {
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
      },
      fingerprint: "plugin-apps-empty",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: emptyPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/resume"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
  });

  it("rebuilds a partial plugin app binding after another plugin recovers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: "plugin-apps-partial",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext: createPluginAppPolicyContext(),
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-recovered");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const recoveredPolicyContext = createTwoPluginAppPolicyContext();
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: createTwoPluginAppConfigPatch(),
      fingerprint: "plugin-apps-config-2",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: recoveredPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar", "gmail"],
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      ...createTwoPluginAppConfigPatch(),
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-recovered");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-2");
    expect(binding?.pluginAppPolicyContext).toEqual(recoveredPolicyContext);
  });

  it("rebuilds a partial plugin app binding after another app from the same plugin recovers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      dynamicToolsFingerprint: "[]",
      pluginAppsFingerprint: "plugin-apps-partial",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext: {
        ...createPluginAppPolicyContext(),
        pluginAppIds: {
          "google-calendar": ["google-calendar-app", "google-calendar-secondary-app"],
        },
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-recovered");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const recoveredPolicyContext = createTwoCalendarAppPolicyContext();
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: createTwoCalendarAppConfigPatch(),
      fingerprint: "plugin-apps-config-calendar-2",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: recoveredPolicyContext,
      diagnostics: [],
    }));

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildPluginThreadConfig,
      },
    });

    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      ...createTwoCalendarAppConfigPatch(),
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-recovered");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-calendar-2");
    expect(binding?.pluginAppPolicyContext).toEqual(recoveredPolicyContext);
  });

  it("starts a new configured thread for legacy bindings missing plugin app metadata", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-plugins");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const pluginAppPolicyContext = createPluginAppPolicyContext();

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        build: async () => ({
          enabled: true,
          configPatch: createPluginAppConfigPatch(),
          fingerprint: "plugin-apps-config-1",
          inputFingerprint: "plugin-apps-input-1",
          policyContext: pluginAppPolicyContext,
          diagnostics: [],
        }),
      },
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      ...createPluginAppConfigPatch(),
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-plugins");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("starts a new Codex thread when dynamic tool schemas change", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let nextThread = 1;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-${nextThread++}`);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createMessageDynamicTool("Send and manage messages.", ["send"])],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createMessageDynamicTool("Send and manage messages.", ["send", "read"])],
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
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
    expect(resumeConfig?.["features.codex_hooks"]).toBe(true);
    expect(resumeConfig?.["features.code_mode"]).toBe(true);
    expect(resumeConfig?.["features.code_mode_only"]).toBe(true);
    expect(resumeRequestParams?.developerInstructions).toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    const turnRequest = requests.find((request) => request.method === "turn/start");
    const turnRequestParams = turnRequest?.params as Record<string, unknown> | undefined;
    expect(turnRequestParams?.approvalPolicy).toBe("on-request");
    expect(turnRequestParams?.approvalsReviewer).toBe("guardian_subagent");
    expect(turnRequestParams?.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turnRequestParams?.serviceTier).toBe("priority");
    expect(turnRequestParams?.model).toBe("gpt-5.4-codex");
  });

  it("clamps Codex danger-full-access when OpenClaw sandboxing is active", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: {
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    });

    const sandboxed = __testing.restrictCodexAppServerSandboxForOpenClawSandbox(appServer, {
      enabled: true,
    } as never);
    expect(sandboxed).not.toBe(appServer);
    expect(sandboxed.approvalPolicy).toBe("never");
    expect(sandboxed.sandbox).toBe("workspace-write");

    expect(__testing.restrictCodexAppServerSandboxForOpenClawSandbox(appServer, null)).toBe(
      appServer,
    );
    expect(
      __testing.restrictCodexAppServerSandboxForOpenClawSandbox(
        { ...appServer, sandbox: "read-only" },
        { enabled: true } as never,
      ).sandbox,
    ).toBe("read-only");
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

  it("keys plugin app inventory by websocket credentials without exposing them", () => {
    const first = __testing.resolveCodexPluginAppCacheEndpoint({
      start: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-first",
        headers: { Authorization: "Bearer first" },
      },
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 5,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    const second = __testing.resolveCodexPluginAppCacheEndpoint({
      start: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-second",
        headers: { Authorization: "Bearer second" },
      },
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 5,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("token-first");
    expect(first).not.toContain("Bearer first");
    expect(second).not.toContain("token-second");
    expect(second).not.toContain("Bearer second");
  });

  it("builds resume and turn params from the currently selected OpenClaw model", () => {
    const params = createParams("/tmp/session.jsonl", "/tmp/workspace");
    const appServer = {
      start: {
        transport: "stdio" as const,
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      },
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 60_000,
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "guardian_subagent" as const,
      sandbox: "danger-full-access" as const,
      serviceTier: "flex" as const,
    };

    const resumeParams = buildThreadResumeParams(params, { threadId: "thread-1", appServer });
    expect(resumeParams).toEqual({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      config: {
        "features.code_mode": true,
        "features.code_mode_only": true,
      },
      sandbox: "danger-full-access",
      serviceTier: "flex",
      developerInstructions: resumeParams.developerInstructions,
      persistExtendedHistory: true,
    });
    expect(resumeParams.developerInstructions).toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    const turnParams = buildTurnStartParams(params, {
      threadId: "thread-1",
      cwd: "/tmp/workspace",
      appServer,
    });
    expect(turnParams.threadId).toBe("thread-1");
    expect(turnParams.cwd).toBe("/tmp/workspace");
    expect(turnParams.model).toBe("gpt-5.4-codex");
    expect(turnParams.approvalPolicy).toBe("on-request");
    expect(turnParams.approvalsReviewer).toBe("guardian_subagent");
    expect(turnParams.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turnParams.serviceTier).toBe("flex");
    expect(turnParams.collaborationMode).toEqual({
      mode: "default",
      settings: {
        model: "gpt-5.4-codex",
        reasoning_effort: "medium",
        developer_instructions: null,
      },
    });
  });

  it("uses turn-scoped collaboration instructions for heartbeat Codex turns", () => {
    const params = createParams("/tmp/session.jsonl", "/tmp/workspace");
    params.trigger = "heartbeat";

    const heartbeatCollaborationMode = buildTurnCollaborationMode(params);
    expect(heartbeatCollaborationMode.mode).toBe("default");
    expect(heartbeatCollaborationMode.settings.model).toBe("gpt-5.4-codex");
    expect(heartbeatCollaborationMode.settings.reasoning_effort).toBe("medium");
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake",
    );
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "Use heartbeats to create useful proactive progress",
    );
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "If `heartbeat_respond` is not already available and `tool_search` is available",
    );

    params.trigger = "user";
    expect(buildTurnCollaborationMode(params).settings.developer_instructions).toBeNull();
  });

  it("preserves the bound auth profile when resume params omit authProfileId", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai-codex:bound",
    });
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;
    params.agentDir = path.join(tempDir, "agent");

    const binding = await startOrResumeThread({
      client: {
        request: async (method: string) => {
          if (method === "thread/resume") {
            return threadStartResult("thread-existing");
          }
          throw new Error(`unexpected method: ${method}`);
        },
      } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: {
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
      },
    });

    expect(binding.authProfileId).toBe("openai-codex:bound");
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
