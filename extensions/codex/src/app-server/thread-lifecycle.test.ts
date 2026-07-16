// Codex tests cover thread lifecycle plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "../../prompt-overlay.js";
import { CodexAppServerRpcError } from "./client.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE } from "./protocol.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerPendingSupervisionBranch,
} from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { createCodexTestModel } from "./test-support.js";
import {
  buildDeveloperInstructions,
  buildTurnCollaborationMode,
  buildTurnStartParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  areCodexDynamicToolFingerprintsCompatible,
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
  resolveCodexAppServerThreadModelSelection,
  resolveReasoningEffort,
  startOrResumeThread as startOrResumeThreadImpl,
} from "./thread-lifecycle.js";

type CodexThreadLifecycleTimingLogger = NonNullable<
  NonNullable<Parameters<typeof startOrResumeThreadImpl>[0]["timing"]>["log"]
>;

describe("Codex ring-zero thread config", () => {
  it("applies the restriction to both thread start and resume", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.toolsAllow = ["openclaw"];
    const appServer = createAppServerOptions() as never;
    const start = buildThreadStartParams(params, {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      hostSystemAgentActive: true,
      nativeCodeModeEnabled: false,
    });
    const resume = buildThreadResumeParams(params, {
      appServer,
      dynamicTools: [],
      hostSystemAgentActive: true,
      nativeCodeModeEnabled: false,
      threadId: "thread-1",
    });

    expect(start.environments).toEqual([]);
    expect(start.baseInstructions).toBe("");
    for (const config of [start.config, resume.config]) {
      expect(config?.["tools.experimental_request_user_input.enabled"]).toBe(false);
      expect(config?.["features.multi_agent"]).toBe(false);
      expect(config?.["features.multi_agent_v2"]).toBe(false);
      expect(config?.["features.goals"]).toBe(false);
      expect(config?.["orchestrator.mcp.enabled"]).toBe(false);
      expect(config?.["orchestrator.skills.enabled"]).toBe(false);
      expect(config?.project_doc_max_bytes).toBe(0);
      expect(config?.hooks).toMatchObject({
        PreToolUse: [],
        SessionStart: [],
        UserPromptSubmit: [],
        Stop: [],
      });
    }

    const normal = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      appServer,
      cwd: "/repo",
      dynamicTools: [],
      hostSystemAgentActive: false,
    });
    expect(normal.baseInstructions).toBeUndefined();
  });
});

function startOrResumeThread(
  params: Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">,
) {
  return startOrResumeThreadImpl({ ...params, bindingStore: testCodexAppServerBindingStore });
}

let tempDir: string;

function createAttemptParams(params: {
  provider: string;
  authProfileId?: string;
  authProfileType?: "oauth" | "api_key";
  authProfileProvider?: string;
  authProfileProviders?: Record<string, string>;
  runtimeExternalProfileIds?: string[];
  bootstrapContextMode?: "full" | "lightweight";
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  images?: EmbeddedRunAttemptParams["images"];
  modelId?: string;
}): EmbeddedRunAttemptParams {
  const authProfileProviders =
    params.authProfileProviders ??
    (params.authProfileId
      ? { [params.authProfileId]: params.authProfileProvider ?? "openai" }
      : {});
  const authProfileType = params.authProfileType ?? "oauth";
  return {
    provider: params.provider,
    modelId: params.modelId ?? "gpt-5.4",
    prompt: "test prompt",
    authProfileId: params.authProfileId,
    ...(params.bootstrapContextMode ? { bootstrapContextMode: params.bootstrapContextMode } : {}),
    ...(params.bootstrapContextRunKind
      ? { bootstrapContextRunKind: params.bootstrapContextRunKind }
      : {}),
    ...(params.images ? { images: params.images } : {}),
    authProfileStore: {
      version: 1,
      profiles: Object.fromEntries(
        Object.entries(authProfileProviders).map(([profileId, provider]) => [
          profileId,
          authProfileType === "api_key"
            ? {
                type: "api_key" as const,
                provider,
                key: "sk-test",
              }
            : {
                type: "oauth" as const,
                provider,
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60_000,
              },
        ]),
      ),
      ...(params.runtimeExternalProfileIds
        ? { runtimeExternalProfileIds: params.runtimeExternalProfileIds }
        : {}),
    },
  } as EmbeddedRunAttemptParams;
}

function createAppServerOptions() {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  };
}

function createNetworkProxyAppServerOptions() {
  const configPatch = {
    "features.network_proxy.enabled": true,
    default_permissions: "mock-proxy",
    permissions: {
      "mock-proxy": {
        filesystem: {
          ":minimal": "read",
          ":project_roots": {
            ".": "write",
          },
        },
        network: {
          enabled: true,
          domains: {
            "api.openai.com": "allow",
          },
          allow_upstream_proxy: true,
          proxy_url: "http://127.0.0.1:3128",
        },
      },
    },
  } as const;
  return {
    ...createAppServerOptions(),
    networkProxy: {
      profileName: "mock-proxy",
      configFingerprint: "test-network-proxy",
      configPatch,
    },
  } as const;
}

function createThreadLifecycleParams(
  sessionFile: string,
  workspaceDir: string,
): EmbeddedRunAttemptParams {
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
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    requestTimeoutMs: 60_000,
    turnCompletionIdleTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

async function seedAdoptedThreadBinding(params: EmbeddedRunAttemptParams, cwd: string) {
  const threadId = "thread-adopted";
  const request = vi.fn(async (method: string) => {
    if (method === "thread/start") {
      return threadStartResult(threadId);
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await startOrResumeThread({
    client: { request } as never,
    params,
    cwd,
    dynamicTools: [],
    appServer: createThreadLifecycleAppServerOptions(),
  });
  const identity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const patched = await testCodexAppServerBindingStore.mutate(identity, {
    kind: "patch",
    threadId,
    patch: {
      model: undefined,
      modelProvider: undefined,
      preserveNativeModel: true,
    },
  });
  if (!patched) {
    throw new Error("failed to seed adopted Codex thread binding");
  }
  return { identity, threadId };
}

async function seedPendingSupervisionBinding(params: {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  pending: CodexAppServerPendingSupervisionBranch;
}) {
  const pending = {
    connectionFingerprint: buildCodexAppServerConnectionFingerprint(
      createThreadLifecycleAppServerOptions(),
    ),
    ...params.pending,
  };
  const identity = sessionBindingIdentity({
    sessionId: params.attempt.sessionId,
    sessionKey: params.attempt.sessionKey,
    agentId: params.attempt.agentId,
    config: params.attempt.config,
  });
  const written = await testCodexAppServerBindingStore.mutate(identity, {
    kind: "set",
    if: { kind: "absent" },
    binding: {
      threadId: pending.sourceThreadId,
      cwd: params.cwd,
      connectionScope: "supervision",
      supervisionSourceThreadId: pending.sourceThreadId,
      preserveNativeModel: true,
      pendingSupervisionBranch: pending,
      conversationSourceTransferComplete: true,
      historyCoveredThrough: new Date(0).toISOString(),
    },
  });
  if (!written) {
    throw new Error("failed to seed pending Codex supervision binding");
  }
  return identity;
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
      cwd: tempDir,
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
    cwd: tempDir,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function nativeThreadResult(threadId: string, model: string, modelProvider: string) {
  const response = threadStartResult(threadId);
  return {
    ...response,
    model,
    modelProvider,
    thread: { ...response.thread, modelProvider },
  };
}

function sourceThread(params: {
  threadId: string;
  status?: "idle" | "active";
  turns?: Array<Record<string, unknown>>;
}) {
  return {
    ...threadStartResult(params.threadId).thread,
    status: { type: params.status ?? "idle" },
    turns: params.turns ?? [],
  };
}

function createTimingLogger(traceEnabled: boolean): CodexThreadLifecycleTimingLogger {
  return {
    isEnabled: vi.fn((level: "trace") => level === "trace" && traceEnabled),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

function expectSingleLogMessage(
  log: CodexThreadLifecycleTimingLogger,
  level: "trace" | "warn",
): string {
  const mock = log[level] as ReturnType<typeof vi.fn>;
  expect(mock).toHaveBeenCalledTimes(1);
  const message = mock.mock.calls[0]?.[0];
  expect(typeof message).toBe("string");
  return message as string;
}

describe("Codex app-server native code mode config", () => {
  it("keeps Codex-native subagents primary while limiting OpenClaw spawn to OpenClaw delegation", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }));

    expect(instructions).toContain("Use Codex native `spawn_agent` for Codex subagents");
    // Codex defers native collab tools behind tool_search on search-capable
    // models; the instructions must teach the retrieval path or models fall
    // back to the always-direct sessions_spawn.
    expect(instructions).toContain(
      "when `spawn_agent` is not directly listed, load it with `tool_search` before spawning",
    );
    expect(instructions).toContain(
      "Use OpenClaw `sessions_spawn` only for OpenClaw or ACP delegation, never as a substitute for `spawn_agent`.",
    );
  });

  it("summarizes deferred dynamic tool names in developer instructions", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          type: "function",
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object" },
        },
        {
          type: "namespace",
          name: "openclaw",
          description: "",
          tools: [
            {
              type: "function",
              name: "music_generate",
              description: "Create music",
              inputSchema: { type: "object" },
              deferLoading: true,
            },
            {
              type: "function",
              name: "image_generate",
              description: "Create images",
              inputSchema: { type: "object" },
              deferLoading: true,
            },
          ],
        },
      ],
    });

    expect(instructions).toContain(
      "Deferred searchable OpenClaw dynamic tools available: image_generate, music_generate.",
    );
    expect(instructions).toContain("Use `tool_search` to load exact callable specs before use.");
    expect(instructions).not.toContain("message,");
  });

  it("uses the shared Skill Workshop guidance when skill_workshop is available", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          type: "namespace",
          name: "openclaw",
          description: "",
          tools: [
            {
              type: "function",
              name: "skill_workshop",
              description: "Manage skill proposals",
              inputSchema: { type: "object" },
              deferLoading: true,
            },
          ],
        },
      ],
    });

    expect(instructions).toContain("## Skill Workshop");
    expect(instructions).toContain("Durable reusable skill/playbook/workflow work");
    expect(instructions).toContain("`skill_workshop`");
    expect(instructions).toContain("Generated = pending proposal");
    expect(instructions).toContain("only explicit user ask");
  });

  it("keeps developer instructions compact when no dynamic tools are deferred", () => {
    const instructions = buildDeveloperInstructions(createAttemptParams({ provider: "openai" }), {
      dynamicTools: [
        {
          type: "function",
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(instructions).not.toContain("Deferred searchable OpenClaw dynamic tools available");
  });

  it("instructs Codex to mark only completed message-tool-only source replies final", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.sourceReplyDeliveryMode = "message_tool_only";

    const instructions = buildDeveloperInstructions(params, {
      dynamicTools: [
        {
          type: "function",
          name: "message",
          description: "Send a message",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(instructions).toContain("For progress, set `final=false`.");
    expect(instructions).toContain("set `final=true`");
  });

  it("keeps durable dynamic tool fingerprints scoped to loading mode", () => {
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    };
    const directFingerprint = codexDynamicToolsFingerprint([
      {
        type: "function",
        name: "message",
        description: "Send a visible message",
        inputSchema,
      },
    ]);
    const searchableFingerprint = codexDynamicToolsFingerprint([
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function",
            name: "message",
            description: "Load and send a visible message",
            inputSchema,
            deferLoading: true,
          },
        ],
      },
    ]);

    expect(searchableFingerprint).not.toBe(directFingerprint);
  });

  it("keeps hashed dynamic tool fingerprints compatible with legacy JSON bindings", () => {
    const tools = [
      {
        type: "function" as const,
        name: "message",
        description: "Send a visible message",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    ];
    const hashed = codexDynamicToolsFingerprint(tools);
    const legacy = codexLegacyDynamicToolsFingerprint(tools);

    expect(hashed).toMatch(/^sha256:/);
    expect(legacy).toContain('"name":"message"');
    expect(
      areCodexDynamicToolFingerprintsCompatible({
        previous: legacy,
        next: hashed,
        nextLegacy: legacy,
      }),
    ).toBe(true);
  });

  it("keeps OpenClaw skill catalogs out of developer instructions", () => {
    const params = createAttemptParams({ provider: "openai" });
    params.skillsSnapshot = {
      prompt: "<available_skills><skill><name>demo</name></skill></available_skills>",
      skills: [],
    };

    const instructions = buildDeveloperInstructions(params);

    expect(instructions).not.toContain("<available_skills>");
  });

  it("enables Codex code mode on thread/start without clobbering other config", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      config: {
        "features.hooks": true,
        apps: { _default: { enabled: false } },
        mcp_servers: {
          local_docs: {
            command: "node",
            args: ["/opt/local-docs-mcp/dist/index.js"],
          },
        },
      },
    });

    expect(request.config).toEqual({
      "features.hooks": true,
      apps: { _default: { enabled: false } },
      mcp_servers: {
        local_docs: {
          command: "node",
          args: ["/opt/local-docs-mcp/dist/index.js"],
        },
      },
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
    expect(request.personality).toBe("none");
  });

  it("enables hosted Codex web search on thread/start by default", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "codex" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it("disables hosted Codex web search for tool-disabled runs", () => {
    const params = createAttemptParams({ provider: "codex" });
    params.disableTools = true;
    const request = buildThreadStartParams(params, {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("disables hosted Codex web search when effective tool policy denies web_search", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "codex" }), {
      cwd: "/repo",
      dynamicTools: [],
      webSearchAllowed: false,
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("disables native Codex search when runtime policy disables native tools", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "codex" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeCodeModeEnabled: false,
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("disables hosted Codex web search when the active provider lacks support", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "codex" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeProviderWebSearchSupport: "unsupported",
    });

    expect(request.config).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("selects the Codex network-proxy permissions profile in thread/start config", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createNetworkProxyAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("sandbox");
    expect(request.config).toMatchObject({
      "features.network_proxy.enabled": true,
      default_permissions: "mock-proxy",
      permissions: {
        "mock-proxy": {
          network: {
            enabled: true,
            allow_upstream_proxy: true,
            proxy_url: "http://127.0.0.1:3128",
          },
        },
      },
    });
  });

  it("selects the Codex network-proxy permissions profile in thread/resume config", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createNetworkProxyAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("sandbox");
    expect(request.config).toMatchObject({
      "features.network_proxy.enabled": true,
      default_permissions: "mock-proxy",
      permissions: {
        "mock-proxy": {
          network: {
            domains: {
              "api.openai.com": "allow",
            },
          },
        },
      },
    });
  });

  it("disables Codex tool-search features for nano models", () => {
    const request = buildThreadStartParams(
      createAttemptParams({ provider: "openai", modelId: "gpt-5.4-nano" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "features.multi_agent": false,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it("removes Codex model personality on thread/resume", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.personality).toBe("none");
  });

  it("omits OpenClaw model selection when adopting a native Codex thread", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "codex" }), {
      threadId: "thread-adopted",
      model: "openclaw-model",
      modelProvider: "openclaw-provider",
      preserveNativeModel: true,
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("modelProvider");
  });

  it("keeps Codex model personality disabled on turn/start", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
    });

    expect(request.personality).toBe("none");
  });

  it("does not overwrite native supervised turn settings", () => {
    const params = createAttemptParams({ provider: "anthropic" });
    params.thinkLevel = "high";
    const request = buildTurnStartParams(params, {
      threadId: "thread-supervised",
      cwd: "/repo",
      model: "native-model",
      modelProvider: "native-provider",
      appServer: createAppServerOptions() as never,
      preserveNativeTurnSettings: true,
    });

    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("effort");
    expect(request).not.toHaveProperty("collaborationMode");
    expect(request).not.toHaveProperty("personality");
  });

  it("honors an explicit top-level reviewer on thread start and resume", () => {
    const appServer = {
      ...createAppServerOptions(),
      approvalsReviewer: "auto_review" as const,
    };
    const config = { approvals_reviewer: "user" };

    const started = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: appServer as never,
      developerInstructions: "test instructions",
      config,
    });
    const resumed = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: appServer as never,
      developerInstructions: "test instructions",
      config,
    });

    expect(started.approvalsReviewer).toBe("user");
    expect(resumed.approvalsReviewer).toBe("user");
  });

  it("keeps the configured runtime reviewer on turn start", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: {
        ...createAppServerOptions(),
        approvalsReviewer: "auto_review",
      } as never,
    });

    expect(request.approvalsReviewer).toBe("auto_review");
  });

  it("allows thread config to opt into Codex code-mode-only", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      config: {
        "features.code_mode_only": true,
      },
    });

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
      "features.apply_patch_streaming_events": true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it("forces Codex code-mode-only when app-server policy opts in", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeCodeModeOnlyEnabled: true,
      config: {
        "features.code_mode_only": false,
      },
    });

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
      "features.apply_patch_streaming_events": true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it.each([false, true])(
    "keeps direct-only dynamic namespaces model-visible when code-mode-only=%s",
    (nativeCodeModeOnlyEnabled) => {
      const dynamicTools = [
        {
          type: "namespace" as const,
          name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
          description: "",
          tools: [],
        },
      ];
      const config = {
        "code_mode.direct_only_tool_namespaces": ["vendor_direct"],
      };
      const startRequest = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
        cwd: "/repo",
        dynamicTools,
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        nativeCodeModeOnlyEnabled,
        config,
      });
      const resumeRequest = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
        threadId: "thread-1",
        dynamicTools,
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        nativeCodeModeOnlyEnabled,
        config,
      });

      for (const request of [startRequest, resumeRequest]) {
        expect(request.config?.["code_mode.direct_only_tool_namespaces"]).toEqual([
          "vendor_direct",
          CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
        ]);
        expect(request.config?.["features.code_mode_only"]).toBe(nativeCodeModeOnlyEnabled);
      }
    },
  );

  it("enables Codex code mode on thread/resume", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it("disables Codex native code mode on thread/start when runtime policy denies it", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeCodeModeEnabled: false,
      nativeCodeModeOnlyEnabled: true,
      config: {
        "features.code_mode": true,
        "features.code_mode_only": true,
        "features.apply_patch_streaming_events": true,
      },
    });

    expect(request.config).toEqual({
      "features.code_mode": false,
      "features.code_mode_only": false,
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("disables Codex native code mode on thread/resume when runtime policy denies it", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      nativeCodeModeEnabled: false,
      config: {
        "features.apply_patch_streaming_events": true,
      },
    });

    expect(request.config).toEqual({
      "features.code_mode": false,
      "features.code_mode_only": false,
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("disables native Codex project docs for lightweight context threads", () => {
    const request = buildThreadStartParams(
      createAttemptParams({
        provider: "openai",
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "cron",
      }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        config: {
          project_doc_max_bytes: 64_000,
          "features.hooks": true,
        },
      },
    );

    expect(request.config).toEqual({
      project_doc_max_bytes: 0,
      "features.hooks": true,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });

  it("keeps native Codex project docs enabled when context is not lightweight", () => {
    const request = buildThreadResumeParams(
      createAttemptParams({ provider: "openai", bootstrapContextRunKind: "cron" }),
      {
        threadId: "thread-1",
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        config: {
          project_doc_max_bytes: 64_000,
        },
      },
    );

    expect(request.config).toEqual({
      project_doc_max_bytes: 64_000,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "features.standalone_web_search": false,
      web_search: "cached",
    });
  });
});

describe("Codex app-server turn input image sanitizing", () => {
  it("uses an explicit turn sandbox policy override when provided", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo"],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });

    expect(request.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("uses Codex permissions for network-proxy turn/start requests", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createNetworkProxyAppServerOptions() as never,
    });

    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("sandboxPolicy");
  });

  it("keeps explicit sandbox policy overrides ahead of network-proxy turn permissions", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createNetworkProxyAppServerOptions() as never,
      sandboxPolicy: {
        type: "externalSandbox",
        networkAccess: "enabled",
      },
    });

    expect(request).not.toHaveProperty("permissions");
    expect(request.sandboxPolicy).toEqual({
      type: "externalSandbox",
      networkAccess: "enabled",
    });
  });

  it("attaches turn-scoped developer instructions without changing thread config", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
      turnScopedDeveloperInstructions: "SOUL.md turn-only context",
    });

    expect(request.collaborationMode?.settings.developer_instructions).toContain(
      "# Collaboration Mode: Default",
    );
    expect(request.collaborationMode?.settings.developer_instructions).toContain(
      "SOUL.md turn-only context",
    );
  });

  it("places memory collaboration instructions before skills", () => {
    const request = buildTurnStartParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
      turnScopedDeveloperInstructions: "SOUL.md turn-only context",
      memoryCollaborationInstructions: "MEMORY.md pointer",
      skillsCollaborationInstructions: "<available_skills>",
    });
    const developerInstructions = request.collaborationMode?.settings.developer_instructions ?? "";

    expect(developerInstructions.indexOf("SOUL.md turn-only context")).toBeLessThan(
      developerInstructions.indexOf("MEMORY.md pointer"),
    );
    expect(developerInstructions.indexOf("MEMORY.md pointer")).toBeLessThan(
      developerInstructions.indexOf("<available_skills>"),
    );
  });

  it("replaces malformed inline images before turn/start", () => {
    const request = buildTurnStartParams(
      createAttemptParams({
        provider: "openai",
        images: [{ type: "image", mimeType: "image/jpeg", data: "not base64!" }] as never,
      }),
      {
        threadId: "thread-1",
        cwd: "/repo",
        appServer: createAppServerOptions() as never,
      },
    );

    expect(request.input).toEqual([
      { type: "text", text: "test prompt", text_elements: [] },
      {
        type: "text",
        text: "[codex user input] omitted image payload: invalid inline image data",
        text_elements: [],
      },
    ]);
  });
});

describe("Codex app-server turn params", () => {
  it("builds resume and turn params from the currently selected OpenClaw model", () => {
    const params = createAttemptParams({ provider: "codex" });
    params.modelId = "gpt-5.4-codex";
    params.thinkLevel = "medium";
    const appServer = {
      start: {
        transport: "stdio" as const,
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      },
      codeModeOnly: false,
      loopDetectionPreToolUseRelay: true,
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 60_000,
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "guardian_subagent" as const,
      sandbox: "danger-full-access" as const,
      connectionClass: "local-loopback" as const,
      remoteAppsSubstrate: "preconfigured" as const,
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
        "features.code_mode_only": false,
        "features.apply_patch_streaming_events": true,
        "features.standalone_web_search": false,
        web_search: "cached",
      },
      sandbox: "danger-full-access",
      serviceTier: "flex",
      personality: "none",
      developerInstructions: resumeParams.developerInstructions,
    });
    expect(resumeParams.developerInstructions).not.toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
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
    const params = createAttemptParams({ provider: "codex" });
    params.modelId = "gpt-5.4-codex";
    params.thinkLevel = "medium";
    params.trigger = "heartbeat";

    const heartbeatCollaborationMode = buildTurnCollaborationMode(params, {
      heartbeatCollaborationInstructions:
        "HEARTBEAT.md exists at /tmp/workspace/HEARTBEAT.md. Read it before proceeding.",
    });
    expect(heartbeatCollaborationMode.mode).toBe("default");
    expect(heartbeatCollaborationMode.settings.model).toBe("gpt-5.4-codex");
    expect(heartbeatCollaborationMode.settings.reasoning_effort).toBe("medium");
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake",
    );
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "Heartbeat = useful proactive progress",
    );
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "If `heartbeat_respond` is not already available and `tool_search` is available",
    );
    expect(heartbeatCollaborationMode.settings.developer_instructions).toContain(
      "HEARTBEAT.md exists at /tmp/workspace/HEARTBEAT.md.",
    );

    params.bootstrapContextRunKind = "commitment-only";
    const commitmentCollaborationMode = buildTurnCollaborationMode(params, {
      turnScopedDeveloperInstructions: "Turn-only workspace instructions.",
      heartbeatCollaborationInstructions:
        "HEARTBEAT.md exists at /tmp/workspace/HEARTBEAT.md. Read it before proceeding.",
    });
    expect(commitmentCollaborationMode.settings.developer_instructions).toContain(
      "# Collaboration Mode: Default",
    );
    expect(commitmentCollaborationMode.settings.developer_instructions).toContain(
      "Turn-only workspace instructions.",
    );
    expect(commitmentCollaborationMode.settings.developer_instructions).not.toContain(
      "This is an OpenClaw heartbeat turn",
    );
    expect(commitmentCollaborationMode.settings.developer_instructions).not.toContain(
      "HEARTBEAT.md exists at /tmp/workspace/HEARTBEAT.md.",
    );

    params.trigger = "user";
    expect(
      buildTurnCollaborationMode(params, {
        turnScopedDeveloperInstructions: "Turn-only workspace instructions.",
        heartbeatCollaborationInstructions:
          "HEARTBEAT.md exists at /tmp/workspace/HEARTBEAT.md. Read it before proceeding.",
      }).settings.developer_instructions,
    ).toContain("Turn-only workspace instructions.");
    expect(
      buildTurnCollaborationMode(params, {
        turnScopedDeveloperInstructions: "Turn-only workspace instructions.",
      }).settings.developer_instructions,
    ).toContain("# Collaboration Mode: Default");
  });

  it("uses turn-scoped collaboration instructions for cron Codex turns", () => {
    const params = createAttemptParams({ provider: "codex" });
    params.modelId = "gpt-5.4-codex";
    params.thinkLevel = "medium";
    params.trigger = "cron";

    const cronCollaborationMode = buildTurnCollaborationMode(params, {
      turnScopedDeveloperInstructions: "Turn-only workspace instructions.",
    });
    expect(cronCollaborationMode.mode).toBe("default");
    expect(cronCollaborationMode.settings.model).toBe("gpt-5.4-codex");
    expect(cronCollaborationMode.settings.reasoning_effort).toBe("medium");
    expect(cronCollaborationMode.settings.developer_instructions).toContain(
      "This is an OpenClaw cron automation turn",
    );
    expect(cronCollaborationMode.settings.developer_instructions).toContain(
      "If it asks you to run an exact command, run that command before doing any investigation",
    );
    expect(cronCollaborationMode.settings.developer_instructions).toContain(
      "Use context already provided by the runtime",
    );
    expect(cronCollaborationMode.settings.developer_instructions).toContain(
      "Turn-only workspace instructions.",
    );
  });
});

describe("Codex app-server model provider selection", () => {
  it.each(["openai", "openai"])(
    "omits public %s modelProvider when forwarding native Codex auth on thread/start",
    (provider) => {
      const request = buildThreadStartParams(
        createAttemptParams({
          provider,
          authProfileId: "work",
          runtimeExternalProfileIds: ["work"],
        }),
        {
          cwd: "/repo",
          dynamicTools: [],
          appServer: createAppServerOptions() as never,
          developerInstructions: "test instructions",
        },
      );

      expect(request).not.toHaveProperty("modelProvider");
    },
  );

  it("uses the bound native Codex auth profile when deciding thread/resume modelProvider", () => {
    const request = buildThreadResumeParams(
      createAttemptParams({
        provider: "openai",
        authProfileProviders: { bound: "openai" },
        runtimeExternalProfileIds: ["bound"],
      }),
      {
        threadId: "thread-1",
        authProfileId: "bound",
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request).not.toHaveProperty("modelProvider");
  });

  it("does not infer native Codex auth from the profile id prefix", () => {
    const request = buildThreadStartParams(
      createAttemptParams({
        provider: "openai",
        authProfileId: "openai:work",
        authProfileType: "api_key",
        authProfileProvider: "openai",
      }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request.modelProvider).toBe("openai");
  });

  it("omits public OpenAI modelProvider for persisted Codex OAuth profiles", () => {
    const request = buildThreadStartParams(
      createAttemptParams({
        provider: "openai",
        authProfileId: "openai:work",
        authProfileProvider: "openai",
      }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request).not.toHaveProperty("modelProvider");
  });

  it("keeps public OpenAI modelProvider when no native Codex auth profile is selected", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.modelProvider).toBe("openai");
  });

  it("splits provider-qualified model refs for app-server thread/start", () => {
    const request = buildThreadStartParams(
      createAttemptParams({ provider: "codex", modelId: "lmstudio/local-model" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request.model).toBe("local-model");
    expect(request.modelProvider).toBe("lmstudio");
  });

  it("uses provider-qualified model refs for thread capability selection", () => {
    expect(
      resolveCodexAppServerThreadModelSelection({
        provider: "codex",
        model: "amazon-bedrock/local-model",
      }),
    ).toEqual({
      model: "local-model",
      modelProvider: "amazon-bedrock",
    });
  });

  it("uses a matching bound provider for thread capability selection", () => {
    expect(
      resolveCodexAppServerThreadModelSelection({
        provider: "codex",
        model: "local-model",
        binding: {
          threadId: "thread-1",
          model: "local-model",
          modelProvider: "amazon-bedrock",
        },
      }),
    ).toEqual({
      model: "local-model",
      modelProvider: "amazon-bedrock",
    });
  });

  it("prefers provider-qualified models over bound providers for thread capability selection", () => {
    expect(
      resolveCodexAppServerThreadModelSelection({
        provider: "codex",
        model: "openai/gpt-5.5",
        binding: {
          threadId: "thread-1",
          model: "local-model",
          modelProvider: "amazon-bedrock",
        },
      }),
    ).toEqual({
      model: "gpt-5.5",
      modelProvider: "openai",
    });
  });

  it("normalizes provider-qualified model refs for turn/start metadata", () => {
    const request = buildTurnStartParams(
      createAttemptParams({ provider: "codex", modelId: "lmstudio/local-model" }),
      {
        threadId: "thread-1",
        cwd: "/repo",
        appServer: createAppServerOptions() as never,
      },
    );

    const collaborationMode = request.collaborationMode as { settings?: Record<string, unknown> };
    expect(request.model).toBe("local-model");
    expect(collaborationMode.settings?.model).toBe("local-model");
  });
});

describe("Codex plugin binding recovery", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-plugin-recovery-"));
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does not rebuild a binding whose configured plugin is a settled negative", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-settled");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const build = vi.fn(async () => ({
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
      fingerprint: "plugin-config-settled",
      inputFingerprint: "plugin-input-settled",
      policyContext: { fingerprint: "plugin-policy-settled", apps: {}, pluginAppIds: {} },
      diagnostics: [],
    }));
    const common = {
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await startOrResumeThread({
      ...common,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-input-settled",
        enabledPluginConfigKeys: ["calendar"],
        recoverablePluginConfigKeys: ["calendar"],
        build,
      },
    });
    await startOrResumeThread({
      ...common,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-input-settled",
        enabledPluginConfigKeys: ["calendar"],
        recoverablePluginConfigKeys: [],
        build,
      },
    });

    expect(build).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
  });

  it("rebuilds once when a settled negative binding still enables the plugin", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-settled-transition");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const build = vi
      .fn()
      .mockResolvedValueOnce({
        enabled: true,
        configPatch: { apps: { calendar: { enabled: true } } },
        fingerprint: "plugin-config-active",
        inputFingerprint: "plugin-input-settled",
        policyContext: {
          fingerprint: "plugin-policy-active",
          apps: {
            calendar: {
              configKey: "calendar",
              marketplaceName: "openai-curated" as const,
              pluginName: "calendar",
              allowDestructiveActions: false,
              mcpServerNames: [],
            },
          },
          pluginAppIds: { calendar: ["calendar"] },
        },
        diagnostics: [],
      })
      .mockResolvedValue({
        enabled: true,
        configPatch: { apps: { _default: { enabled: false } } },
        fingerprint: "plugin-config-settled",
        inputFingerprint: "plugin-input-settled",
        policyContext: { fingerprint: "plugin-policy-settled", apps: {}, pluginAppIds: {} },
        diagnostics: [],
      });
    const common = {
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await startOrResumeThread({
      ...common,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-input-settled",
        enabledPluginConfigKeys: ["calendar"],
        recoverablePluginConfigKeys: ["calendar"],
        build,
      },
    });
    const settledProvider = {
      enabled: true,
      inputFingerprint: "plugin-input-settled",
      enabledPluginConfigKeys: ["calendar"],
      recoverablePluginConfigKeys: [],
      build,
    };
    await startOrResumeThread({ ...common, pluginThreadConfig: settledProvider });
    await startOrResumeThread({ ...common, pluginThreadConfig: settledProvider });

    expect(build).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
  });
});

describe("Codex app-server adopted thread lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-thread-adoption-"));
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("keeps OpenClaw from overriding App Server model selection across resumes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
    let resumeCount = 0;
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: threadStartResult(threadId).thread };
      }
      if (method === "thread/resume") {
        resumeCount += 1;
        return {
          ...threadStartResult(threadId),
          model: `native-model-${resumeCount}`,
          modelProvider: resumeCount === 1 ? "lmstudio" : "ollama",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const commonParams = {
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };
    const firstBinding = await startOrResumeThread(commonParams);
    const secondBinding = await startOrResumeThread(commonParams);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/read",
      "thread/resume",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({ threadId, includeTurns: false });
    expect(request.mock.calls[2]?.[1]).toEqual({ threadId, includeTurns: false });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("modelProvider");
    expect(request.mock.calls[3]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[3]?.[1]).not.toHaveProperty("modelProvider");
    expect(firstBinding).toMatchObject({
      model: "native-model-1",
      modelProvider: "lmstudio",
      preserveNativeModel: true,
    });
    expect(secondBinding).toMatchObject({
      model: "native-model-2",
      modelProvider: "ollama",
      preserveNativeModel: true,
    });

    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({
      model: "native-model-2",
      modelProvider: "ollama",
      preserveNativeModel: true,
    });
  });

  it("rejects an adopted thread that is active in another runner before reserving it", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(sessionFile, workspaceDir);
    const { threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return {
          thread: {
            ...threadStartResult(threadId).thread,
            status: { type: "active" },
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const reserveResumeThread = vi.fn(() => ({ release: vi.fn() }));

    await expect(
      startOrResumeThread({
        client: { request } as never,
        reserveResumeThread,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("active in another runner");

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
    expect(reserveResumeThread).not.toHaveBeenCalled();
  });
});

describe("Codex app-server supervised branch lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-supervision-"));
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("materializes a model-locked canonical branch and injects the same visible snapshot once", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const lastTurnId = "turn-terminal";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    attempt.modelId = "outer-global-default";
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId, lastTurnId },
    });
    const terminalSource = sourceThread({
      threadId: sourceThreadId,
      turns: [
        {
          id: lastTurnId,
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "Visible question" }],
            },
            { id: "reasoning-1", type: "reasoning", text: "Private reasoning" },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "Visible answer",
              phase: "final_answer",
            },
            { id: "tool-1", type: "commandExecution", command: "secret-tool" },
          ],
        },
      ],
    });
    const request = vi.fn(async (method: string, requestParams: unknown) => {
      if (method === "thread/read") {
        const threadId = (requestParams as { threadId?: string }).threadId;
        return {
          thread:
            threadId === sourceThreadId
              ? terminalSource
              : sourceThread({ threadId: finalThreadId }),
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start" || method === "thread/resume") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/inject_items" || method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const dynamicTools = [
      {
        type: "function" as const,
        name: "message",
        description: "Send a message",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const commonParams = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools,
      environmentSelection: [{ environmentId: "local", cwd: workspaceDir }],
      appServer: createThreadLifecycleAppServerOptions(),
      appServerRuntimeFingerprint: "codex-runtime-v1",
    };

    const materialized = await startOrResumeThread(commonParams);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/start",
      "thread/inject_items",
      "thread/archive",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({
      threadId: sourceThreadId,
      includeTurns: true,
    });
    const forkParams = request.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(forkParams).toMatchObject({
      threadId: sourceThreadId,
      lastTurnId,
      excludeTurns: true,
    });
    expect(forkParams).not.toHaveProperty("model");
    expect(forkParams).not.toHaveProperty("modelProvider");
    expect(forkParams).not.toHaveProperty("dynamicTools");
    expect(forkParams).not.toHaveProperty("environments");
    const startParams = request.mock.calls[2]?.[1] as Record<string, unknown>;
    expect(startParams).toMatchObject({
      model: "native-effective",
      modelProvider: "native-provider",
      dynamicTools,
      environments: [{ environmentId: "local", cwd: workspaceDir }],
    });
    expect(startParams.model).not.toBe(attempt.modelId);
    expect(request.mock.calls[3]?.[1]).toEqual({
      threadId: finalThreadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Visible question" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Visible answer" }],
          phase: "final_answer",
        },
      ],
    });
    expect(JSON.stringify(request.mock.calls[3]?.[1])).not.toContain("Private reasoning");
    expect(JSON.stringify(request.mock.calls[3]?.[1])).not.toContain("secret-tool");
    expect(request.mock.calls[4]?.[1]).toEqual({ threadId: probeThreadId });
    expect(materialized).toMatchObject({
      threadId: finalThreadId,
      model: "native-effective",
      modelProvider: "native-provider",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      lifecycle: { action: "forked" },
    });
    expect(materialized.pendingSupervisionBranch).toBeUndefined();
    expect(materialized.historyCoveredThrough).not.toBe(new Date(0).toISOString());
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: finalThreadId,
      model: "native-effective",
      modelProvider: "native-provider",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(commonParams.appServer),
    });

    request.mockClear();
    const resumed = await startOrResumeThread({
      ...commonParams,
      appServerRuntimeFingerprint: "codex-runtime-v2",
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/resume"]);
    expect(request.mock.calls[0]?.[1]).toEqual({ threadId: finalThreadId, includeTurns: false });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("modelProvider");
    expect(resumed).toMatchObject({
      threadId: finalThreadId,
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      lifecycle: { action: "resumed" },
    });
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(commonParams.appServer),
    });
  });

  it("rejects materialization after the supervised source connection changes", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId: "thread-source" },
    });
    const request = vi.fn();
    const appServer = createThreadLifecycleAppServerOptions();
    appServer.start.command = "different-codex";

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer,
      }),
    ).rejects.toThrow("source connection changed before branch materialization");
    expect(request).not.toHaveBeenCalled();
  });

  it("recovers every persisted orphan before materializing a fresh canonical branch", async () => {
    const sourceThreadId = "thread-source";
    const orphanProbeThreadId = "thread-orphan-probe";
    const orphanFinalThreadId = "thread-orphan-final";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const lastTurnId = "turn-terminal";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: {
        sourceThreadId,
        lastTurnId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
    });
    const connectionFingerprint = buildCodexAppServerConnectionFingerprint(
      createThreadLifecycleAppServerOptions(),
    );
    const mutations: Parameters<CodexAppServerBindingStore["mutate"]>[1][] = [];
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: async (storeIdentity, mutation) => {
        mutations.push(mutation);
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      },
    };
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/archive") {
        return {};
      }
      if (method === "thread/read") {
        return {
          thread: sourceThread({
            threadId: sourceThreadId,
            turns: [{ id: lastTurnId, status: "completed", items: [] }],
          }),
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).resolves.toMatchObject({
      threadId: finalThreadId,
      lifecycle: { action: "forked" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/archive",
      "thread/archive",
      "thread/read",
      "thread/fork",
      "thread/start",
      "thread/archive",
    ]);
    expect(request.mock.calls.map(([, requestParams]) => requestParams)).toEqual([
      { threadId: orphanProbeThreadId },
      { threadId: orphanFinalThreadId },
      { threadId: sourceThreadId, includeTurns: true },
      expect.any(Object),
      expect.any(Object),
      { threadId: probeThreadId },
    ]);
    expect(mutations[0]).toEqual({
      kind: "patch-pending-supervision-branch",
      expected: {
        sourceThreadId,
        connectionFingerprint,
        lastTurnId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
      pending: { sourceThreadId, connectionFingerprint, lastTurnId },
    });
    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({ threadId: finalThreadId });
    expect(persisted?.pendingSupervisionBranch).toBeUndefined();
  });

  it("persists exact remaining orphan cleanup and performs no branch work after partial failure", async () => {
    const sourceThreadId = "thread-source";
    const orphanProbeThreadId = "thread-orphan-probe";
    const orphanFinalThreadId = "thread-orphan-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: {
        sourceThreadId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
    });
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      const threadId = (requestParams as { threadId?: string } | undefined)?.threadId;
      if (method === "thread/archive" && threadId === orphanProbeThreadId) {
        return {};
      }
      if (method === "thread/archive" && threadId === orphanFinalThreadId) {
        throw new CodexAppServerRpcError(
          { code: -32_000, message: "temporary archive failure" },
          method,
        );
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow(`cleanup must finish before retry: ${orphanFinalThreadId}`);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/archive",
      "thread/archive",
      "thread/unsubscribe",
    ]);
    expect(request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [orphanFinalThreadId],
      },
    });
  });

  it("fails closed when persisted orphan cleanup loses its state CAS", async () => {
    const sourceThreadId = "thread-source";
    const orphanProbeThreadId = "thread-orphan-probe";
    const orphanFinalThreadId = "thread-orphan-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: {
        sourceThreadId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (
          mutation.kind === "patch-pending-supervision-branch" &&
          mutation.expected.cleanupThreadIds?.length === 2 &&
          !mutation.pending.cleanupThreadIds
        ) {
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("recovering a supervised Codex branch");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/archive",
      "thread/archive",
    ]);
    expect(request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [orphanProbeThreadId, orphanFinalThreadId],
      },
    });
  });

  it.each([
    {
      name: "active source",
      thread: sourceThread({ threadId: "thread-source", status: "active" }),
    },
    {
      name: "source with uncaptured turns",
      thread: sourceThread({
        threadId: "thread-source",
        turns: [{ id: "turn-late", status: "completed", items: [] }],
      }),
    },
  ])("fails closed for a zero-turn snapshot when the $name changed", async ({ thread }) => {
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId: "thread-source" },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("source changed after Continue");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
  });

  it("keeps a structured fork rejection retryable without touching the source", async () => {
    const sourceThreadId = "thread-source";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    let forkAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        forkAttempts += 1;
        if (forkAttempts === 1) {
          throw new CodexAppServerRpcError(
            { code: -32_000, message: "temporary fork rejected" },
            method,
          );
        }
        return nativeThreadResult("thread-probe", "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult("thread-final", "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const commonParams = {
      client: { request } as never,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await expect(startOrResumeThread(commonParams)).rejects.toThrow("temporary fork rejected");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/fork"]);
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: { sourceThreadId },
    });

    request.mockClear();
    await expect(startOrResumeThread(commonParams)).resolves.toMatchObject({
      threadId: "thread-final",
      lifecycle: { action: "forked" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/start",
      "thread/archive",
    ]);
  });

  it("tracks both materialized ids before observing abort and archives both", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const lastTurnId = "turn-terminal";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId, lastTurnId },
    });
    const abortController = new AbortController();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return {
          thread: sourceThread({
            threadId: sourceThreadId,
            turns: [{ id: lastTurnId, status: "completed", items: [] }],
          }),
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        abortController.abort("cancelled after canonical start");
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        signal: abortController.signal,
      }),
    ).rejects.toThrow("cancelled after canonical start");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/start",
      "thread/archive",
      "thread/archive",
    ]);
    expect(request.mock.calls.slice(3).map(([, params]) => params)).toEqual([
      { threadId: probeThreadId },
      { threadId: finalThreadId },
    ]);
    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: { sourceThreadId, lastTurnId },
    });
    expect(persisted?.pendingSupervisionBranch?.cleanupThreadIds).toBeUndefined();
  });

  it("archives both materialized ids when canonical cleanup tracking loses its CAS", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method} ${JSON.stringify(requestParams)}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (
          mutation.kind === "patch-pending-supervision-branch" &&
          mutation.pending.cleanupThreadIds?.join(",") === `${probeThreadId},${finalThreadId}`
        ) {
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("tracking supervised Codex branch cleanup");
    const archivedThreadIds = request.mock.calls
      .filter(([method]) => method === "thread/archive")
      .map(([, requestParams]) => (requestParams as { threadId: string }).threadId);
    expect(archivedThreadIds).toEqual([probeThreadId, finalThreadId]);
    expect(abandonClient).not.toHaveBeenCalled();
    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [probeThreadId],
      },
    });
  });

  it("does not clean the committed canonical thread when post-commit diagnostics fail", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        timing: {
          enabled: true,
          now: () => 0,
          log: {
            isEnabled: () => true,
            trace: () => {
              throw new Error("timing log failed");
            },
            warn: vi.fn(),
          },
        },
      }),
    ).rejects.toThrow("timing log failed");
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).not.toHaveBeenCalled();
    const committedBinding = await testCodexAppServerBindingStore.read(identity);
    expect(committedBinding).toMatchObject({ threadId: finalThreadId });
    expect(committedBinding).not.toHaveProperty("pendingSupervisionBranch");
  });

  it("confirms an applied canonical commit after the binding write reports failure", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (storeIdentity, mutation) => {
        const result = await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        if (mutation.kind === "commit-pending-supervision-branch") {
          throw new Error("binding write failed after commit");
        }
        return result;
      }),
    };

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).resolves.toMatchObject({
      threadId: finalThreadId,
      lifecycle: { action: "forked" },
    });
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    const committedBinding = await testCodexAppServerBindingStore.read(identity);
    expect(committedBinding).toMatchObject({ threadId: finalThreadId });
    expect(committedBinding).not.toHaveProperty("pendingSupervisionBranch");
  });

  it("rejects an applied commit when verification sees a changed connection", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn(async (storeIdentity) => {
        const current = await testCodexAppServerBindingStore.read(storeIdentity);
        if (current?.threadId !== finalThreadId || current.pendingSupervisionBranch) {
          return current;
        }
        return { ...current, appServerRuntimeFingerprint: "changed-connection" };
      }),
      mutate: vi.fn(async (storeIdentity, mutation) => {
        const result = await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
        if (mutation.kind === "commit-pending-supervision-branch") {
          throw new Error("binding write failed after commit");
        }
        return result;
      }),
    };
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow(`binding changed while commit was uncertain: ${finalThreadId}`);
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).toHaveBeenCalledOnce();
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: finalThreadId,
    });
  });

  it("abandons without cleanup when a failed canonical commit cannot be verified", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    let commitFailed = false;
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn(async (storeIdentity) => {
        if (commitFailed) {
          throw new Error("binding verification read failed");
        }
        return await testCodexAppServerBindingStore.read(storeIdentity);
      }),
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (mutation.kind === "commit-pending-supervision-branch") {
          commitFailed = true;
          throw new Error("binding commit failed");
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow(`binding could not be verified: ${finalThreadId}`);
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).toHaveBeenCalledOnce();
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [finalThreadId],
      },
    });
  });

  it("abandons without cleanup when failed commit verification sees a changed connection", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return nativeThreadResult(finalThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    let commitFailed = false;
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn(async (storeIdentity) => {
        const current = await testCodexAppServerBindingStore.read(storeIdentity);
        if (!commitFailed || !current?.pendingSupervisionBranch) {
          return current;
        }
        return {
          ...current,
          pendingSupervisionBranch: {
            ...current.pendingSupervisionBranch,
            connectionFingerprint: "changed-connection",
          },
        };
      }),
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (mutation.kind === "commit-pending-supervision-branch") {
          commitFailed = true;
          throw new Error("binding commit failed");
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        abandonClient,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow(`binding changed while commit was uncertain: ${finalThreadId}`);
    expect(
      request.mock.calls
        .filter(([method]) => method === "thread/archive")
        .map(([, requestParams]) => requestParams),
    ).toEqual([{ threadId: probeThreadId }]);
    expect(abandonClient).toHaveBeenCalledOnce();
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: {
        sourceThreadId,
        cleanupThreadIds: [finalThreadId],
      },
    });
  });

  it("abandons an untrackable probe response after known cleanup", async () => {
    const sourceThreadId = "thread-source";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return { thread: { id: "" } };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("model probe may have materialized without a safe thread id");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/fork"]);
    expect(abandonClient).toHaveBeenCalledOnce();
  });

  it("cleans the known probe before abandoning an untrackable canonical response", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/start") {
        return { thread: { id: "" } };
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("canonical branch may have materialized without a safe thread id");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/start",
      "thread/archive",
    ]);
    expect(request.mock.calls[3]?.[1]).toEqual({ threadId: probeThreadId });
    expect(request.mock.invocationCallOrder[3]).toBeLessThan(
      abandonClient.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(abandonClient).toHaveBeenCalledOnce();
    const persisted = await testCodexAppServerBindingStore.read(identity);
    expect(persisted).toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: { sourceThreadId },
    });
    expect(persisted?.pendingSupervisionBranch?.cleanupThreadIds).toBeUndefined();
  });

  it("archives an untracked probe when the cleanup CAS loses a race", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId },
    });
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/read") {
        return { thread: sourceThread({ threadId: sourceThreadId }) };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (storeIdentity, mutation) => {
        if (
          mutation.kind === "patch-pending-supervision-branch" &&
          mutation.pending.cleanupThreadIds?.includes(probeThreadId)
        ) {
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(storeIdentity, mutation);
      }),
    };

    await expect(
      startOrResumeThreadImpl({
        client: { request } as never,
        bindingStore,
        params: attempt,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
      }),
    ).rejects.toThrow("tracking supervised Codex branch cleanup");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/archive",
    ]);
    expect(request.mock.calls[2]?.[1]).toEqual({ threadId: probeThreadId });
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: sourceThreadId,
      pendingSupervisionBranch: { sourceThreadId },
    });
  });
});

describe("Codex app-server thread lifecycle timing", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-thread-lifecycle-"));
    // Bindings are keyed by session identity, not tempDir, so sibling tests
    // would otherwise leak resumable threads into fresh-start expectations.
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("emits a trace stage summary when starting a new thread with trace enabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    let nowMs = 0;
    const log = createTimingLogger(true);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        nowMs += 17;
        return threadStartResult("thread-started");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createThreadLifecycleParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      timing: {
        enabled: true,
        now: () => nowMs,
        log,
        totalThresholdMs: 1_000,
        stageThresholdMs: 1_000,
      },
    });

    const message = expectSingleLogMessage(log, "trace");
    expect(log.warn).not.toHaveBeenCalled();
    expect(message).toContain("action=started");
    expect(message).toContain("thread-start-request:17ms@17ms");
    expect(message).toContain("thread-ready:0ms@17ms");
  });

  it("emits a trace stage summary when resuming an existing thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    let nowMs = 0;
    const log = createTimingLogger(true);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        nowMs += 9;
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const commonParams = {
      client: { request } as never,
      params: createThreadLifecycleParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    };

    await startOrResumeThread({
      ...commonParams,
      timing: {
        enabled: true,
        now: () => nowMs,
        log: createTimingLogger(false),
      },
    });
    await startOrResumeThread({
      ...commonParams,
      timing: {
        enabled: true,
        now: () => nowMs,
        log,
        totalThresholdMs: 1_000,
        stageThresholdMs: 1_000,
      },
    });

    const message = expectSingleLogMessage(log, "trace");
    expect(message).toContain("action=resumed");
    expect(message).toContain("thread-resume-request:9ms@9ms");
  });

  it("warns on slow start even when trace logging is disabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    let nowMs = 0;
    const log = createTimingLogger(false);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        nowMs += 25;
        return threadStartResult("thread-slow");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createThreadLifecycleParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      timing: {
        enabled: true,
        now: () => nowMs,
        log,
        totalThresholdMs: 10,
        stageThresholdMs: 10,
      },
    });

    const message = expectSingleLogMessage(log, "warn");
    expect(log.trace).not.toHaveBeenCalled();
    expect(message).toContain("action=started");
    expect(message).toContain("thread-start-request:25ms@25ms");
  });
});

describe("resolveReasoningEffort (#71946)", () => {
  describe("modern Codex models (none/low/medium/high/xhigh enum)", () => {
    it.each([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ] as const)(
      "translates 'minimal' -> 'low' for %s so the first request is accepted",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("low");
      },
    );

    it.each([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ] as const)(
      "passes 'low' / 'medium' / 'high' / 'xhigh' through unchanged for %s",
      (modelId) => {
        expect(resolveReasoningEffort("low", modelId)).toBe("low");
        expect(resolveReasoningEffort("medium", modelId)).toBe("medium");
        expect(resolveReasoningEffort("high", modelId)).toBe("high");
        expect(resolveReasoningEffort("xhigh", modelId)).toBe("xhigh");
      },
    );

    it("normalizes case-variant model ids", () => {
      expect(resolveReasoningEffort("minimal", "GPT-5.5")).toBe("low");
      expect(resolveReasoningEffort("minimal", " gpt-5.4-mini ")).toBe("low");
    });

    it.each(["gpt-5.5-pro", "gpt-5.4-pro"] as const)(
      "uses the %s minimum effort when metadata is unavailable",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("medium");
        expect(resolveReasoningEffort("low", modelId)).toBe("medium");
        expect(resolveReasoningEffort("medium", modelId)).toBe("medium");
        expect(resolveReasoningEffort("max", modelId)).toBe("xhigh");
      },
    );

    it("honors stricter app-server reasoning metadata", () => {
      const supported = ["medium", "high", "xhigh"];

      expect(resolveReasoningEffort("minimal", "gpt-5.5-pro", supported)).toBe("medium");
      expect(resolveReasoningEffort("low", "gpt-5.5-pro", supported)).toBe("medium");
      expect(resolveReasoningEffort("medium", "gpt-5.5-pro", supported)).toBe("medium");
      expect(resolveReasoningEffort("max", "gpt-5.5-pro", supported)).toBe("xhigh");
    });
  });

  describe("legacy / non-modern Codex models", () => {
    it.each(["gpt-5", "gpt-4o", "o3-mini", "codex-mini-latest"] as const)(
      "preserves 'minimal' for %s — pre-modern enum still supports it",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("minimal");
      },
    );

    it("preserves 'minimal' for empty / unknown model ids (conservative default)", () => {
      expect(resolveReasoningEffort("minimal", "")).toBe("minimal");
      expect(resolveReasoningEffort("minimal", "unknown-model-xyz")).toBe("minimal");
    });
  });

  describe("non-effort thinkLevel values", () => {
    it("returns null for 'off'", () => {
      expect(resolveReasoningEffort("off", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("off", "gpt-4o")).toBeNull();
    });

    it("returns null for 'adaptive' (non-effort enum value)", () => {
      expect(resolveReasoningEffort("adaptive", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("adaptive", "gpt-4o")).toBeNull();
    });

    it("passes max only for known native GPT-5.6 models", () => {
      expect(resolveReasoningEffort("max", "gpt-5.6-sol")).toBe("max");
      expect(resolveReasoningEffort("max", "gpt-5.6-terra")).toBe("max");
      expect(resolveReasoningEffort("max", "gpt-5.6-luna")).toBe("max");
      expect(resolveReasoningEffort("max", "gpt-5.6")).toBeNull();
      expect(resolveReasoningEffort("max", "gpt-5.6-sol-oai")).toBeNull();
      expect(resolveReasoningEffort("max", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("max", "gpt-4o")).toBeNull();
    });

    it("uses known GPT-5.6 fallbacks when app-server metadata is unavailable", () => {
      const ultraEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
      const maxEfforts = ["low", "medium", "high", "xhigh", "max"];

      expect(resolveReasoningEffort("ultra", "gpt-5.6-sol", ultraEfforts)).toBe("ultra");
      expect(resolveReasoningEffort("ultra", "gpt-5.6-terra", ultraEfforts)).toBe("ultra");
      expect(resolveReasoningEffort("ultra", "gpt-5.6-luna", maxEfforts)).toBe("max");
      expect(resolveReasoningEffort("ultra", "gpt-5.6-sol")).toBe("ultra");
      expect(resolveReasoningEffort("ultra", "gpt-5.6-terra")).toBe("ultra");
      expect(resolveReasoningEffort("ultra", "gpt-5.6-luna")).toBe("max");
    });
  });
});

describe("native Codex Ultra turn mapping", () => {
  it.each([
    { modelId: "gpt-5.6-sol", expected: "ultra" },
    { modelId: "gpt-5.6-terra", expected: "ultra" },
    { modelId: "gpt-5.6-luna", expected: "max" },
  ] as const)(
    "maps Ultra to $expected for $modelId with direct OpenAI API metadata",
    ({ modelId, expected }) => {
      const params = createAttemptParams({
        provider: "openai",
        modelId,
        authProfileId: "openai:api-key",
        authProfileType: "api_key",
      });
      params.thinkLevel = "ultra" as EmbeddedRunAttemptParams["thinkLevel"];
      params.model = {
        ...createCodexTestModel("openai"),
        id: modelId,
        compat: {
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        } as never,
      };

      const request = buildTurnStartParams(params, {
        threadId: "thread-ultra",
        cwd: "/repo",
        appServer: createAppServerOptions() as never,
      });

      expect(request.effort).toBe(expected);
      expect(request.collaborationMode?.settings.reasoning_effort).toBe(expected);
      expect(request).not.toHaveProperty("multiAgentMode");
    },
  );

  it("lets authoritative app-server model/list metadata override the fallback", () => {
    const params = createAttemptParams({ provider: "codex", modelId: "gpt-5.6-sol" });
    params.thinkLevel = "ultra" as EmbeddedRunAttemptParams["thinkLevel"];
    params.model = {
      ...createCodexTestModel("codex"),
      id: "gpt-5.6-sol",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      } as never,
    };

    const request = buildTurnStartParams(params, {
      threadId: "thread-native-catalog",
      cwd: "/repo",
      appServer: createAppServerOptions() as never,
    });

    expect(request.effort).toBe("max");
    expect(request.collaborationMode?.settings.reasoning_effort).toBe("max");
    expect(request).not.toHaveProperty("multiAgentMode");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
