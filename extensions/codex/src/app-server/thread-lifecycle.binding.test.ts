// Codex tests cover thread lifecycle.binding plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import type { CodexDynamicToolFunctionSpec } from "./protocol.js";
import {
  createParams as createRunAttemptParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";

function startOrResumeThread(
  params: Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">,
) {
  registerCodexTestSessionIdentity(
    params.params.sessionFile,
    params.params.sessionId,
    params.params.sessionKey,
  );
  return startOrResumeThreadImpl({
    ...params,
    bindingStore: testCodexAppServerBindingStore,
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
    loopDetectionPreToolUseRelay: true,
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

function createNetworkProxyThreadLifecycleAppServerOptions() {
  const configPatch = {
    "features.network_proxy.enabled": true,
    default_permissions: "openclaw-network",
    permissions: {
      "openclaw-network": {
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
          proxy_url: "http://127.0.0.1:3128",
        },
      },
    },
  };
  return {
    ...createThreadLifecycleAppServerOptions(),
    networkProxy: {
      profileName: "openclaw-network",
      configFingerprint: "test-network-proxy",
      configPatch,
    },
  };
}

function createParams(sessionFile: string, workspaceDir: string) {
  const params = createRunAttemptParams(sessionFile, workspaceDir);
  params.disableTools = false;
  params.config = undefined;
  return params;
}

const DEFAULT_CODEX_RUNTIME_THREAD_CONFIG = {
  "features.goals": false,
  "features.code_mode": true,
  "features.code_mode_only": false,
  "features.apply_patch_streaming_events": true,
  "features.standalone_web_search": false,
  web_search: "cached",
} as const;

const DEFAULT_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "cached",
});

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding] = args;
  registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
  return writeRawCodexAppServerBinding(sessionFile, {
    webSearchThreadConfigFingerprint: DEFAULT_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
    ...binding,
  });
}

function createMessageDynamicTool(
  description: string,
  actions: string[] = ["send"],
): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
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

function createNamedDynamicTool(name: string): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function createDeferredNamedDynamicTool(
  name: string,
): Parameters<typeof startOrResumeThread>[0]["dynamicTools"][number] {
  return {
    type: "namespace",
    name: "openclaw",
    description: "",
    tools: [{ ...createNamedDynamicTool(name), deferLoading: true }],
  };
}

function createPluginAppConfigPatch(options: { approvalsReviewer?: "user" } = {}) {
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
        ...(options.approvalsReviewer ? { approvals_reviewer: options.approvalsReviewer } : {}),
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
        allowDestructiveActions: true,
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

setupRunAttemptTestHooks();

describe("Codex app-server thread lifecycle bindings", () => {
  it("persists the native rollout path across thread start and resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const threadId = "thread-native-rollout";
    const rolloutPath = path.join(
      tempDir,
      "agent",
      "codex-home",
      "sessions",
      `rollout-${threadId}.jsonl`,
    );
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method !== "thread/start" && method !== "thread/resume") {
        throw new Error(`unexpected method: ${method}`);
      }
      const response = threadStartResult(threadId);
      return {
        ...response,
        thread: { ...response.thread, path: rolloutPath },
      };
    });
    const common = {
      client: { getInstanceId: () => "native-rollout-client", request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };

    const started = await startOrResumeThread(common);
    expect(started).toMatchObject({
      threadId,
      rolloutPath,
      lifecycle: { action: "started" },
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId,
      rolloutPath,
    });

    const resumed = await startOrResumeThread(common);
    expect(resumed).toMatchObject({
      threadId,
      rolloutPath,
      lifecycle: { action: "resumed" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId,
      rolloutPath,
    });
  });

  it("reuses only an explicitly retained subscription on the original client", async () => {
    const sessionFile = path.join(tempDir, "warm-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-warm");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const buildFinalConfigPatch = vi
      .fn()
      .mockReturnValueOnce({ nativeHookRelayGeneration: "generation-warm" })
      .mockReturnValueOnce({ nativeHookRelayGeneration: "generation-warm-next" });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
      buildFinalConfigPatch,
    };

    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toEqual({});
    const reused = await startOrResumeThread(common);

    expect(started).toMatchObject({
      clientId: "client-warm",
      threadId: "thread-warm",
      nativeHookRelayGeneration: "generation-warm",
      lifecycle: { action: "started" },
    });
    expect(reused).toMatchObject({
      clientId: "client-warm",
      threadId: "thread-warm",
      nativeHookRelayGeneration: "generation-warm-next",
      lifecycle: { action: "resumed" },
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      nativeHookRelayGeneration: "generation-warm-next",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(buildFinalConfigPatch).toHaveBeenNthCalledWith(1, { action: "start" });
    expect(buildFinalConfigPatch).toHaveBeenNthCalledWith(2, {
      action: "resume",
      binding: expect.objectContaining({ threadId: "thread-warm" }),
    });
  });

  it("reuses an isolated retained thread without dropping native skill isolation", async () => {
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "isolated-state"));
    const sessionFile = path.join(tempDir, "warm-isolated-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-isolated-workspace");
    const personalSkill = path.join(tempDir, ".claude", "skills", "personal", "SKILL.md");
    await fs.mkdir(path.dirname(personalSkill), { recursive: true });
    await fs.writeFile(personalSkill, "personal");
    const personalSkillRealPath = await fs.realpath(personalSkill);
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "skills/list") {
        return {
          data: [
            {
              cwd: workspaceDir,
              errors: [],
              skills: [
                {
                  name: "personal",
                  description: "Personal skill",
                  path: personalSkillRealPath,
                  scope: "user",
                  enabled: true,
                },
              ],
            },
          ],
        };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-warm-isolated");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-isolated",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };

    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toEqual({});
    await expect(startOrResumeThread(common)).resolves.toMatchObject({
      threadId: "thread-warm-isolated",
      lifecycle: { action: "resumed" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["skills/list", "thread/start"]);
    const startRequest = request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(startRequest).toMatchObject({
      config: {
        "skills.include_instructions": false,
        "skills.config": [{ path: personalSkillRealPath, enabled: false }],
      },
    });
  });

  it("releases a retained subscription when its unchanged binding loses ownership", async () => {
    const sessionFile = path.join(tempDir, "warm-conflict-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-conflict-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-warm-conflict");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-conflict",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );
    const conflictBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        if (args[1].kind === "patch") {
          return false;
        }
        return await testCodexAppServerBindingStore.mutate(...args);
      }),
    };

    await expect(
      startOrResumeThreadImpl({ ...common, bindingStore: conflictBindingStore }),
    ).rejects.toMatchObject({ name: "CodexThreadBindingConflictError" });

    expect(conflictBindingStore.mutate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "patch", threadId: "thread-warm-conflict" }),
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
    ]);
  });

  it("releases a retained subscription before changing context-engine mode", async () => {
    const sessionFile = path.join(tempDir, "warm-context-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-context-workspace");
    const params = createParams(sessionFile, workspaceDir);
    let startCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        startCount += 1;
        return threadStartResult(`thread-warm-context-${startCount}`);
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-context",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toEqual({});

    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.contextTokenBudget = 400_000;
    const rotated = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/start",
    ]);
    expect(rotated).toMatchObject({
      threadId: "thread-warm-context-2",
      contextEngine: { engineId: "lossless-claw" },
      lifecycle: { action: "started", rotatedContextEngineBinding: true },
    });
  });

  it("releases and resumes a retained thread when its effective config changes", async () => {
    const sessionFile = path.join(tempDir, "warm-config-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-config-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-config");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-config",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread({
      ...common,
      config: { test_setting: "before" },
    });
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );

    const resumed = await startOrResumeThread({
      ...common,
      config: { test_setting: "after" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/resume",
    ]);
    expect(resumed).toMatchObject({
      threadId: "thread-warm-config",
      lifecycle: { action: "resumed" },
    });
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
  });

  it("releases and resumes a retained thread when its auth profile changes", async () => {
    const sessionFile = path.join(tempDir, "warm-auth-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-auth-workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.authProfileId = "openai:before";
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-auth");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-auth",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );

    params.authProfileId = "openai:after";
    const resumed = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/resume",
    ]);
    expect(resumed).toMatchObject({
      authProfileId: "openai:after",
      threadId: "thread-warm-auth",
      lifecycle: { action: "resumed" },
    });
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
  });

  it("releases and resumes a retained thread when its model provider changes", async () => {
    const sessionFile = path.join(tempDir, "warm-provider-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-provider-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-provider");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-provider",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );

    params.provider = "custom-provider";
    const resumed = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/resume",
    ]);
    expect(request).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ modelProvider: "custom-provider" }),
      expect.anything(),
    );
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
  });

  it("releases and resumes a retained thread when its approval policy changes", async () => {
    const sessionFile = path.join(tempDir, "warm-policy-session.jsonl");
    const workspaceDir = path.join(tempDir, "warm-policy-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-warm-policy");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-warm-policy",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const appServer = createThreadLifecycleAppServerOptions();
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await retainCodexAppServerLiveThread(
      client,
      started.threadId,
      undefined,
      started.liveThreadConfigFingerprint,
    );

    appServer.approvalPolicy = "on-request";
    const resumed = await startOrResumeThread(common);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/resume",
    ]);
    expect(request).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ approvalPolicy: "on-request" }),
      expect.anything(),
    );
    expect(resumed.liveThreadConfigFingerprint).not.toBe(started.liveThreadConfigFingerprint);
  });

  it("fails closed when a retained mode-transition subscription cannot be released", async () => {
    const sessionFile = path.join(tempDir, "unsafe-warm-session.jsonl");
    const workspaceDir = path.join(tempDir, "unsafe-warm-workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-unsafe-warm");
      }
      if (method === "thread/unsubscribe") {
        throw new Error("unsubscribe unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-unsafe-warm",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const abandonClient = vi.fn(async () => undefined);
    const common = {
      client,
      abandonClient,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };
    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toEqual({});

    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    await expect(startOrResumeThread(common)).rejects.toMatchObject({
      name: "CodexAppServerUnsafeSubscriptionError",
      message: "Codex retained thread subscription could not be released: thread-unsafe-warm",
    });

    expect(abandonClient).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
    ]);
  });

  it("reuses one live ephemeral thread across two incognito turns", async () => {
    const sessionFile = path.join(tempDir, "incognito-session.jsonl");
    const workspaceDir = path.join(tempDir, "incognito-workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.sessionKey = "agent:main:dashboard:incognito-two-turns";
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-incognito");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-incognito",
      request,
    } as never;
    const common = {
      client,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
    };

    const first = await startOrResumeThread(common);
    const second = await startOrResumeThread(common);

    expect(first).toMatchObject({
      clientId: "client-incognito",
      threadId: "thread-incognito",
      lifecycle: { action: "started" },
    });
    expect(second).toMatchObject({
      clientId: "client-incognito",
      threadId: "thread-incognito",
      lifecycle: { action: "resumed" },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ ephemeral: true }));
  });

  it("resumes the same restricted OpenClaw thread so turn two retains native memory", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-normal",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    let nextThread = 1;
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return {
          layers: [],
          config: {
            mcp_servers: {
              "arbitrary.server": { command: "ignored" },
              "local helper": { url: "https://mcp.example.test" },
            },
          },
        };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult(`thread-ring-zero-${nextThread++}`);
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-ring-zero-1");
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const common = {
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("openclaw")],
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: true,
    };

    const first = await startOrResumeThread(common);
    const second = await startOrResumeThread(common);

    expect(first.lifecycle.action).toBe("started");
    expect(second.lifecycle.action).toBe("resumed");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "mcpServerStatus/list",
      "config/read",
      "configRequirements/read",
      "thread/resume",
      "mcpServerStatus/list",
    ]);
    const startCalls = request.mock.calls.filter(([method]) => method === "thread/start");
    expect(startCalls.map(([, startParams]) => startParams)).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({
          mcp_servers: {
            "arbitrary.server": { enabled: false },
            "local helper": { enabled: false },
          },
        }),
      }),
    ]);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-ring-zero-1");
    expect(binding?.ringZeroConfigFingerprint).toEqual(expect.any(String));
    expect(binding?.ringZeroClientInstanceId).toEqual(expect.any(String));
  });

  it("starts a fresh restricted OpenClaw thread for a new app-server client", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    let nextThread = 1;
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult(`thread-ring-zero-${nextThread++}`);
      }
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const common = {
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("openclaw")],
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: true,
    };

    const first = await startOrResumeThread({ ...common, client: { request } as never });
    const second = await startOrResumeThread({ ...common, client: { request } as never });

    expect(first.lifecycle.action).toBe("started");
    expect(second.lifecycle.action).toBe("started");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("thread/resume");
    const startCalls = request.mock.calls.filter(([method]) => method === "thread/start");
    expect(startCalls).toHaveLength(2);
    expect(startCalls.map(([, startParams]) => startParams)).toEqual([
      expect.objectContaining({ environments: [] }),
      expect.objectContaining({ environments: [] }),
    ]);
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-ring-zero-2");
  });

  it("retires a warm OpenClaw binding when resume MCP attestation fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    let attestationCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-ring-zero");
      }
      if (method === "mcpServerStatus/list") {
        attestationCount += 1;
        return attestationCount === 1
          ? { data: [], nextCursor: null }
          : { data: [{ name: "late-server" }], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = { request } as never;
    const abandonClient = vi.fn(async () => {});
    const common = {
      client,
      abandonClient,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("openclaw")],
      appServer: createThreadLifecycleAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
      hostSystemAgentActive: true,
    };

    await startOrResumeThread(common);
    await expect(startOrResumeThread(common)).rejects.toThrow(
      "Codex ring-zero MCP attestation failed",
    );

    expect(abandonClient).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "mcpServerStatus/list",
      "config/read",
      "configRequirements/read",
      "thread/resume",
      "mcpServerStatus/list",
    ]);
    expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
  });

  it("fails closed before starting OpenClaw when inherited MCP enumeration fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-normal",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        throw new Error("config unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        cwd: workspaceDir,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      }),
    ).rejects.toThrow("config unavailable");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["config/read"]);
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-normal");
  });

  it.each([
    { name: "legacy managed file", layer: { name: { type: "legacyManagedConfigTomlFromFile" } } },
    { name: "legacy managed MDM", layer: { name: { type: "legacyManagedConfigTomlFromMdm" } } },
    { name: "unknown future", layer: { name: { type: "futureManaged" } } },
    { name: "malformed", layer: { name: {} } },
  ])("fails closed on $name config layers before OpenClaw thread/start", async ({ layer }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [layer] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        cwd: workspaceDir,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      }),
    ).rejects.toThrow(/config layer|config layers/u);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["config/read"]);
  });

  it.each(["hooks", "managed_hooks"] as const)(
    "fails closed on non-empty %s requirements before OpenClaw thread/start",
    async (requirementsKey) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.toolsAllow = ["openclaw"];
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return {
            requirements: {
              [requirementsKey]: {
                PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }],
              },
            },
          };
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          params,
          cwd: workspaceDir,
          dynamicTools: [createNamedDynamicTool("openclaw")],
          appServer: createThreadLifecycleAppServerOptions(),
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
          hostSystemAgentActive: true,
        }),
      ).rejects.toThrow("cannot override managed hooks");
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config/read",
        "configRequirements/read",
      ]);
    },
  );

  it("fails closed when requirements pin a restricted Codex feature on", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: { featureRequirements: { hooks: true } } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        cwd: workspaceDir,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      }),
    ).rejects.toThrow("cannot override required feature hooks");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
    ]);
  });

  it.each([
    { name: "a newly raced server", attestation: { data: [{ name: "raced" }] } },
    { name: "a malformed inventory", attestation: { data: "invalid" } },
    { name: "an inventory RPC failure", attestation: new Error("inventory failed") },
  ])("retires the cold OpenClaw thread when attestation finds $name", async ({ attestation }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-normal",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.toolsAllow = ["openclaw"];
    const abandonClient = vi.fn(async () => {});
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult("thread-ring-zero");
      }
      if (method === "mcpServerStatus/list") {
        if (attestation instanceof Error) {
          throw attestation;
        }
        return attestation;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        abandonClient,
        params,
        cwd: workspaceDir,
        dynamicTools: [createNamedDynamicTool("openclaw")],
        appServer: createThreadLifecycleAppServerOptions(),
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: true,
      }),
    ).rejects.toThrow();
    expect(abandonClient).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "mcpServerStatus/list",
    ]);
    expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
  });

  it("does not write a binding when thread start resolves after abort", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const abortController = new AbortController();
    let resolveStart: ((value: ReturnType<typeof threadStartResult>) => void) | undefined;
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return await new Promise<ReturnType<typeof threadStartResult>>((resolve) => {
          resolveStart = resolve;
        });
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const run = startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      signal: abortController.signal,
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("thread/start", expect.any(Object), {
        signal: abortController.signal,
      }),
    );
    abortController.abort("test_abort");
    resolveStart?.(threadStartResult("thread-after-abort"));

    await expect(run).rejects.toThrow("test_abort");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("resumes a bound Codex thread when only dynamic tool descriptions change", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
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

  it.each([
    ["gpt-5.6-luna", "gpt-5.6-sol"],
    ["gpt-5.6-luna", "gpt-5.6-terra"],
    ["gpt-5.6-sol", "gpt-5.6-luna"],
    ["gpt-5.6-terra", "gpt-5.6-luna"],
  ])("starts a fresh thread when switching from %s to %s", async (bindingModel, requestedModel) => {
    const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: bindingModel,
    });
    const params = createParams(sessionFile, workspaceDir);
    params.modelId = requestedModel;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        const response = threadStartResult("thread-rebound");
        response.model = (requestParams as { model: string }).model;
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ model: requestedModel });
    expect(binding).toMatchObject({
      threadId: "thread-rebound",
      model: requestedModel,
      lifecycle: { action: "started" },
    });
  });

  it.each([
    ["gpt-5.6-sol", "gpt-5.6-terra"],
    ["gpt-5.6-terra", "gpt-5.6-sol"],
  ])("resumes the thread when switching from %s to %s", async (bindingModel, requestedModel) => {
    const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: bindingModel,
    });
    const params = createParams(sessionFile, workspaceDir);
    params.modelId = requestedModel;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/resume") {
        const response = threadStartResult("thread-existing");
        response.model = (requestParams as { model: string }).model;
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      threadId: "thread-existing",
      model: requestedModel,
    });
    expect(binding).toMatchObject({
      threadId: "thread-existing",
      model: requestedModel,
      lifecycle: { action: "resumed" },
    });
  });

  it("sends canonical typed dynamic tools on thread start", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-typed-tools");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        createMessageDynamicTool("Send a message."),
        createDeferredNamedDynamicTool("web_search"),
      ],
      appServer,
    });

    const startParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1] as
      | { dynamicTools?: unknown[] }
      | undefined;
    expect(startParams?.dynamicTools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "message",
        description: "Send a message.",
      }),
      expect.objectContaining({
        type: "namespace",
        name: "openclaw",
        tools: [
          expect.objectContaining({
            type: "function",
            name: "web_search",
            deferLoading: true,
          }),
        ],
      }),
    ]);
  });

  it("keeps the bound local provider when recoverable resume failure starts a fresh thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "local-model-2";
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/resume") {
        // Only a structured RPC rejection proves Codex holds no resume
        // subscription; anything else retires the client instead.
        throw new CodexAppServerRpcError({ code: -32_000, message: "stale thread" }, method);
      }
      if (method === "thread/unsubscribe") {
        return { status: "not_subscribed" };
      }
      if (method === "thread/start") {
        const response = threadStartResult("thread-new");
        response.model = "local-model-2";
        response.modelProvider = "lmstudio";
        response.thread.modelProvider = "lmstudio";
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    const startParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/unsubscribe",
      "thread/start",
    ]);
    expect(startParams?.model).toBe("local-model-2");
    expect(startParams?.modelProvider).toBe("lmstudio");
    expect(binding.threadId).toBe("thread-new");
    expect(binding.modelProvider).toBe("lmstudio");
  });

  it("falls back to a fresh thread when a rejected resume also fails unsubscribe", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        throw new CodexAppServerRpcError({ code: -32_000, message: "thread not found" }, method);
      }
      if (method === "thread/unsubscribe") {
        throw new Error("unsubscribe rejected");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-recovered");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    // The RPC rejection already proves no resume subscription exists, so a
    // failing cosmetic unsubscribe must not block stale-binding recovery.
    const binding = await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-recovered");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/unsubscribe",
      "thread/start",
    ]);
  });

  it("keeps the bound local provider when stale fingerprints force a fresh thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "local-model",
      modelProvider: "lmstudio",
      dynamicToolsFingerprint: "stale-fingerprint",
      dynamicToolsContainDeferred: false,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "local-model-2";
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        const response = threadStartResult("thread-new");
        response.model = "local-model-2";
        response.modelProvider = "lmstudio";
        response.thread.modelProvider = "lmstudio";
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("web_search")],
      appServer,
    });

    const startParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(startParams?.model).toBe("local-model-2");
    expect(startParams?.modelProvider).toBe("lmstudio");
    expect(binding.threadId).toBe("thread-new");
    expect(binding.modelProvider).toBe("lmstudio");
  });

  it("keeps the bound local provider when the bound model id contains a slash", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
      dynamicToolsFingerprint: "[]",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.provider = "codex";
    params.modelId = "openai/gpt-oss-20b";
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/resume") {
        const response = threadStartResult("thread-existing");
        response.model = "openai/gpt-oss-20b";
        response.modelProvider = "lmstudio";
        response.thread.modelProvider = "lmstudio";
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    const resumeParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    expect(resumeParams?.model).toBe("openai/gpt-oss-20b");
    expect(resumeParams?.modelProvider).toBe("lmstudio");
    expect(binding.threadId).toBe("thread-existing");
    expect(binding.modelProvider).toBe("lmstudio");
  });

  it("starts a fresh Codex thread when web search switches to a managed provider", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        // Resume must echo the requested thread; anything else is rejected as
        // an unsafe subscription.
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      appServer,
    });
    params.config = {
      tools: {
        web: {
          search: { provider: "brave" },
        },
      },
    };
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "cached" },
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("uses a transient Codex thread when runtime toolsAllow denies web_search", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
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
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: true,
      appServer,
    });
    params.toolsAllow = ["message"];
    const restrictedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: false,
      appServer,
    });
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.toolsAllow = undefined;
    const resumedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: true,
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(restrictedBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "cached" },
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("uses a transient Codex thread for report-only fallback completion", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    params.delegationCapability = "report_only";
    const restrictedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.delegationCapability = "full";
    const resumedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(restrictedBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      config: {
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      },
    });
  });

  it("preserves the native-search binding when provider capability support is unknown", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeProviderWebSearchSupport: "supported",
      webSearchAllowed: true,
      appServer,
    });
    const transientBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeProviderWebSearchSupport: "unknown",
      webSearchAllowed: true,
      appServer,
    });
    const savedAfterUnknownSupport = await readCodexAppServerBinding(sessionFile);
    const resumedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeProviderWebSearchSupport: "supported",
      webSearchAllowed: true,
      appServer,
    });

    expect(transientBinding.threadId).toBe("thread-2");
    expect(transientBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterUnknownSupport?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "cached" },
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("does not persist a first-turn managed fallback when provider capability support is unknown", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _requestParams?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-transient");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      nativeProviderWebSearchSupport: "unknown",
      webSearchAllowed: true,
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-transient");
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("persists a restricted Codex thread when effective config policy denies web_search", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      webSearchAllowed: true,
      appServer,
    });
    params.config = { tools: { deny: ["web_search"] } };
    params.toolsAllow = [];
    const restrictedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      appServer,
    });
    const resumedRestrictedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(resumedRestrictedBinding.threadId).toBe("thread-2");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
  });

  it("persists config-denied search when runtime toolsAllow also excludes web_search", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      persistentWebSearchAllowed: true,
      webSearchAllowed: true,
      appServer,
    });
    params.config = { tools: { deny: ["web_search"] } };
    params.toolsAllow = ["message"];
    const restrictedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeCodeModeEnabled: false,
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      appServer,
    });
    const resumedRestrictedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      nativeCodeModeEnabled: false,
      persistentWebSearchAllowed: false,
      webSearchAllowed: false,
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(resumedRestrictedBinding.threadId).toBe("thread-2");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
  });

  it("replaces the Codex binding when web search is persistently disabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      appServer,
    });
    params.config = {
      tools: {
        web: {
          search: { enabled: false },
        },
      },
    };
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      webSearchAllowed: false,
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
  });

  it("starts a fresh Codex thread for default hosted search on a legacy binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeRawCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: {
        "features.standalone_web_search": false,
        web_search: "cached",
      },
    });
  });

  it("starts a fresh Codex thread for a restrictive web search policy on a legacy binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeRawCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.config = {
      tools: {
        web: {
          search: { openaiCodex: { enabled: false } },
        },
      },
    };
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("starts a fresh Codex thread for hosted search restrictions on a legacy binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeRawCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    params.config = {
      tools: {
        web: {
          search: { openaiCodex: { allowedDomains: ["example.com"] } },
        },
      },
    };
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      config: {
        web_search: "cached",
        "tools.web_search.allowed_domains": ["example.com"],
      },
    });
  });

  it("starts a fresh Codex thread when an existing session enters tool-disabled mode", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.disableTools = false;
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string, requestParams?: unknown) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
      }
      if (method === "thread/resume") {
        // Resume must echo the requested thread; anything else is rejected as
        // an unsafe subscription.
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    params.disableTools = true;
    const restrictedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.disableTools = false;
    const resumedBinding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      config: { web_search: "disabled" },
    });
  });

  it("starts a fresh Codex thread when dynamic tools switch from deferred to direct", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let starts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        starts += 1;
        return threadStartResult(`thread-${starts}`);
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
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createNamedDynamicTool("web_search")],
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
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

  it("starts a fresh Codex thread for legacy context-engine sidecars without metadata", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.contextTokenBudget = 400_000;
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(binding.lifecycle).toEqual({
      action: "started",
      rotatedContextEngineBinding: true,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine?.engineId).toBe("lossless-claw");
    expect(savedBinding?.contextEngine?.policyFingerprint).toContain('"contextTokenBudget":400000');
  });

  it("resumes a Codex thread when context-engine sidecar metadata is compatible", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const contextEngine = {
      schemaVersion: 1 as const,
      engineId: "lossless-claw",
      policyFingerprint:
        '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
    };
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      contextEngine,
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.contextTokenBudget = 400_000;
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(binding.threadId).toBe("thread-existing");
    expect(binding.lifecycle).toEqual({ action: "resumed" });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
  });

  it("starts a fresh Codex thread when context-engine sidecar metadata is no longer active", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(binding.lifecycle).toEqual({
      action: "started",
      rotatedContextEngineBinding: true,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine).toBeUndefined();
  });

  it("starts a fresh Codex thread when context-engine policy metadata changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","engineVersion":"1.0.0","ownsCompaction":true,"turnMaintenanceMode":"foreground","citationsMode":"inline","contextTokenBudget":400000,"projectionMaxChars":1000000}',
      },
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = {
      info: {
        id: "lossless-claw",
        name: "Lossless Claw",
        version: "1.0.1",
        ownsCompaction: true,
        turnMaintenanceMode: "foreground",
      },
      assemble: vi.fn(),
      compact: vi.fn(),
    } as never;
    params.config = { memory: { citations: "inline" } } as never;
    params.contextTokenBudget = 400_000;
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    expect(binding.threadId).toBe("thread-fresh");
    expect(binding.lifecycle).toEqual({
      action: "started",
      rotatedContextEngineBinding: true,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine?.policyFingerprint).toContain('"engineVersion":"1.0.1"');
    expect(savedBinding?.contextEngine?.policyFingerprint).toContain(
      '"turnMaintenanceMode":"foreground"',
    );
    expect(savedBinding?.contextEngine?.policyFingerprint).toContain('"citationsMode":"inline"');
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
      dynamicTools: [createDeferredNamedDynamicTool("message")],
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
      dynamicTools: [createDeferredNamedDynamicTool("message")],
      appServer,
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.dynamicToolsFingerprint).toBe(fingerprint);
    expect(binding?.dynamicToolsContainDeferred).toBe(true);
    expect(binding?.threadId).toBe("thread-1");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
  });

  it("stores large dynamic tool fingerprints as bounded hashes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-large-tools");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const largeDynamicTools = [
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: Array.from({ length: 200 }, (_, index) => ({
          ...createNamedDynamicTool(`tool_${index}`),
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 20 }, (__, propertyIndex) => [
                `property_${propertyIndex}`,
                {
                  type: "string",
                  description: "x".repeat(200),
                },
              ]),
            ),
            additionalProperties: false,
          },
        })),
      },
    ] satisfies Parameters<typeof startOrResumeThread>[0]["dynamicTools"];

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: largeDynamicTools,
      appServer: createThreadLifecycleAppServerOptions(),
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.dynamicToolsFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(binding?.dynamicToolsFingerprint).toHaveLength(71);
    expect(binding?.dynamicToolsFingerprint).not.toContain("tool_199");
  });

  it("keeps plugin app bindings across transient native-tool-disabled turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      pluginAppsFingerprint: "plugin-apps-config-1",
      pluginAppsInputFingerprint: "plugin-apps-input-1",
      pluginAppPolicyContext,
    });
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-transient");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const buildDenyAllPluginThreadConfig = vi.fn(async () => ({
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
      fingerprint: "plugin-apps-deny-all",
      inputFingerprint: "plugin-apps-input-deny-all",
      policyContext: { fingerprint: "plugin-policy-deny-all", apps: {}, pluginAppIds: {} },
      diagnostics: [],
    }));
    const buildEnabledPluginThreadConfig = vi.fn(async () => ({
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
      nativeCodeModeEnabled: false,
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-deny-all",
        enabledPluginConfigKeys: [],
        build: buildDenyAllPluginThreadConfig,
      },
    });
    const savedAfterDeny = await readCodexAppServerBinding(sessionFile);

    expect(savedAfterDeny?.threadId).toBe("thread-existing");
    expect(savedAfterDeny?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(savedAfterDeny?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");

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
        build: buildEnabledPluginThreadConfig,
      },
    });

    expect(buildDenyAllPluginThreadConfig).toHaveBeenCalledTimes(1);
    expect(buildEnabledPluginThreadConfig).toHaveBeenCalledTimes(1);
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
    expect(requestCalls[0]?.[1].config).toMatchObject({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    const savedAfterAllowed = await readCodexAppServerBinding(sessionFile);
    expect(savedAfterAllowed?.threadId).toBe("thread-existing");
    expect(savedAfterAllowed?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(savedAfterAllowed?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");
    expect(savedAfterAllowed?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("preserves the binding when the app-server closes during thread resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
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

  it("starts a new thread when the network proxy config is not active on the binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const appServer = createNetworkProxyThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-network-proxy");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(requestCalls[0]?.[1]).not.toHaveProperty("sandbox");
    expect(requestCalls[0]?.[1].config).toMatchObject(appServer.networkProxy.configPatch);
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-network-proxy");
    expect(binding?.networkProxyProfileName).toBe("openclaw-network");
    expect(binding?.networkProxyConfigFingerprint).toBe(appServer.networkProxy.configFingerprint);
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
      "features.hooks": true,
      "hooks.PreToolUse": [],
    };
    const expectedConfig = {
      ...config,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
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
      config: { "features.hooks": true, hooks: { PreToolUse: [] } },
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
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      hooks: { PreToolUse: [] },
      ...createPluginAppConfigPatch(),
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-plugins");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-1");
    expect(binding?.pluginAppsInputFingerprint).toBe("plugin-apps-input-1");
    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("keeps native hook relay config as the final thread config patch", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-hooks");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const pluginAppPolicyContext = createPluginAppPolicyContext();
    const finalConfigPatch = {
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [{ type: "command", command: "openclaw-native-hook-relay", timeout: 5 }],
        },
      ],
    };
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: {
        "features.hooks": false,
        "hooks.PreToolUse": [],
        ...createPluginAppConfigPatch(),
      },
      fingerprint: "plugin-apps-config-1",
      inputFingerprint: "plugin-apps-input-1",
      policyContext: pluginAppPolicyContext,
      diagnostics: [],
    }));
    const pluginThreadConfig = {
      enabled: true,
      inputFingerprint: "plugin-apps-input-1",
      build: buildPluginThreadConfig,
    };

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.hooks": false },
      finalConfigPatch,
      pluginThreadConfig,
    });
    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config: { "features.hooks": false },
      finalConfigPatch,
      pluginThreadConfig: {
        ...pluginThreadConfig,
        enabledPluginConfigKeys: ["google-calendar"],
      },
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
    expect(requestCalls[0]?.[1].config).toMatchObject({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      "hooks.PreToolUse": finalConfigPatch["hooks.PreToolUse"],
      ...createPluginAppConfigPatch(),
    });
    expect(requestCalls[1]?.[1].config).toMatchObject({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      "hooks.PreToolUse": finalConfigPatch["hooks.PreToolUse"],
    });
  });

  it("replays compatible plugin app bindings on thread resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = {
      ...createThreadLifecycleAppServerOptions(),
      approvalsReviewer: "auto_review" as const,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("thread-plugins");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const basePolicyContext = createPluginAppPolicyContext();
    const pluginAppPolicyContext = {
      ...basePolicyContext,
      apps: {
        ...basePolicyContext.apps,
        "google-calendar-app": {
          ...basePolicyContext.apps["google-calendar-app"],
          destructiveApprovalMode: "ask" as const,
        },
      },
    };
    const askApprovalConfigPatch = createPluginAppConfigPatch({ approvalsReviewer: "user" });
    const buildPluginThreadConfig = vi.fn(async () => ({
      enabled: true,
      configPatch: askApprovalConfigPatch,
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
      config: { "features.hooks": true },
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
      config: { "features.hooks": true },
      pluginThreadConfig: {
        enabled: true,
        inputFingerprint: "plugin-apps-input-1",
        enabledPluginConfigKeys: ["google-calendar"],
        build: buildPluginThreadConfig,
      },
    });

    expect(binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
    expect(buildPluginThreadConfig).toHaveBeenCalledTimes(2);
    const requestCalls = request.mock.calls as unknown as Array<
      [string, { approvalsReviewer?: string; config?: unknown }]
    >;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
    expect(requestCalls.map(([, requestParams]) => requestParams.approvalsReviewer)).toEqual([
      "auto_review",
      "auto_review",
    ]);
    expect(requestCalls[0]?.[1].config).toEqual({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      ...askApprovalConfigPatch,
    });
    expect(requestCalls[1]?.[1].config).toEqual({
      "features.hooks": true,
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      ...askApprovalConfigPatch,
    });
  });

  it("starts a new plugin app thread when full binding revalidation removes an app", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
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
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
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
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
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
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      ...createPluginAppConfigPatch(),
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
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
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
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
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
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
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
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
  });

  it("rebuilds a partial plugin app binding after another plugin recovers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
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
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-recovered");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-2");
    expect(binding?.pluginAppPolicyContext).toEqual(recoveredPolicyContext);
  });

  it("rebuilds a partial plugin app binding after another app from the same plugin recovers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
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
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
    });
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-recovered");
    expect(binding?.pluginAppsFingerprint).toBe("plugin-apps-config-calendar-2");
    expect(binding?.pluginAppPolicyContext).toEqual(recoveredPolicyContext);
  });

  it("starts a new configured thread for legacy bindings missing plugin app metadata", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
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
      ...DEFAULT_CODEX_RUNTIME_THREAD_CONFIG,
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

  it("preserves the bound auth profile when resume params omit authProfileId", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      authProfileId: "openai:bound",
    });
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;
    params.agentDir = path.join(tempDir, "agent");
    params.authProfileStore = {
      version: 1,
      profiles: {
        "openai:bound": {
          type: "oauth",
          provider: "openai",
          access: "scoped-access",
          refresh: "scoped-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

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
        codeModeOnly: false,
        loopDetectionPreToolUseRelay: true,
        requestTimeoutMs: 60_000,
        turnCompletionIdleTimeoutMs: 60_000,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        connectionClass: "local-loopback",
        remoteAppsSubstrate: "preconfigured",
      },
    });

    expect(binding.authProfileId).toBe("openai:bound");
    expect(binding.modelProvider).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
