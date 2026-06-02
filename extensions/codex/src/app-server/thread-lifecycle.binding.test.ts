import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding, writeCodexAppServerBinding } from "./session-binding.js";
import { startOrResumeThread } from "./thread-lifecycle.js";

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

function createDeferredNamedDynamicTool(
  name: string,
): Parameters<typeof startOrResumeThread>[0]["dynamicTools"][number] {
  return {
    ...createNamedDynamicTool(name),
    namespace: "openclaw",
    deferLoading: true,
  };
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

setupRunAttemptTestHooks();

describe("Codex app-server thread lifecycle bindings", () => {
  it("does not write a binding when thread start resolves after abort", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const abortController = new AbortController();
    let resolveStart: ((value: ReturnType<typeof threadStartResult>) => void) | undefined;
    const request = vi.fn(async (method: string) => {
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "hooks.PreToolUse": finalConfigPatch["hooks.PreToolUse"],
      ...createPluginAppConfigPatch(),
    });
    expect(requestCalls[1]?.[1].config).toMatchObject({
      "features.hooks": true,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      "hooks.PreToolUse": finalConfigPatch["hooks.PreToolUse"],
    });
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
    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
    expect(requestCalls[0]?.[1].config).toEqual({
      "features.hooks": true,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
      ...createPluginAppConfigPatch(),
    });
    expect(requestCalls[1]?.[1].config).toEqual({
      "features.hooks": true,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.apply_patch_streaming_events": true,
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
        requestTimeoutMs: 60_000,
        turnCompletionIdleTimeoutMs: 60_000,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    });

    expect(binding.authProfileId).toBe("openai:bound");
  });
});
