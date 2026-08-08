// Codex tests cover thread lifecycle.user mcp servers plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import {
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  seedCodexTestBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";

const sharedClientMocks = vi.hoisted(() => ({
  retainByInstanceId: undefined as
    | ((clientId: string | undefined) => { client: never; release: () => void } | undefined)
    | undefined,
}));

vi.mock("./shared-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared-client.js")>();
  return {
    ...actual,
    retainSharedCodexAppServerClientByInstanceId: (clientId: string | undefined) =>
      sharedClientMocks.retainByInstanceId
        ? sharedClientMocks.retainByInstanceId(clientId)
        : actual.retainSharedCodexAppServerClientByInstanceId(clientId),
  };
});

function startOrResumeThread(
  params: Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">,
) {
  return startOrResumeThreadImpl({ ...params, bindingStore: testCodexAppServerBindingStore });
}

function threadStartResult(threadId = "thread-1"): Record<string, unknown> {
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
      cwd: "/tmp",
      cliVersion: "0.147.0",
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
    cwd: "/tmp",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function threadResumeResult(threadId = "thread-existing"): Record<string, unknown> {
  return threadStartResult(threadId);
}

function createAppServerOptions(): CodexAppServerRuntimeOptions {
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
  } as unknown as CodexAppServerRuntimeOptions;
}

function createParams(
  sessionFile: string,
  workspaceDir: string,
  configOverrides?: EmbeddedRunAttemptParams["config"],
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
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    config: configOverrides,
  } as unknown as EmbeddedRunAttemptParams;
}

describe("startOrResumeThread — user mcp.servers projection (regression: #80814)", () => {
  let tempDir = "";

  beforeEach(async () => {
    sharedClientMocks.retainByInstanceId = undefined;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-80814-"));
    // Bindings are keyed by session identity, not tempDir, so sibling tests
    // would otherwise leak resumable threads into fresh-start expectations.
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects cfg.mcp.servers into the thread/start config patch under mcp_servers", async () => {
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
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            outlook: {
              transport: "stdio",
              command: "node",
              args: ["/opt/outlook-mcp/dist/index.js"],
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toBeDefined();
    expect(startParams.config!.mcp_servers).toMatchObject({
      outlook: { command: "node", args: ["/opt/outlook-mcp/dist/index.js"] },
    });
  });

  it("stores large user MCP server fingerprints as bounded hashes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: Object.fromEntries(
            Array.from({ length: 120 }, (_, index) => [
              `server_${index}`,
              {
                transport: "stdio",
                command: "node",
                args: [
                  `/opt/openclaw/mcp/server-${index}/dist/index.js`,
                  "--description",
                  "x".repeat(400),
                ],
              },
            ]),
          ),
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(binding?.userMcpServersFingerprint?.length).toBe(71);
    expect(binding?.userMcpServersFingerprint).not.toContain("server_119");
  });

  it.each(["raw", "doctor-hashed"] as const)(
    "resumes beta5 user MCP bindings stored as %s fingerprints",
    async (legacyForm) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      const workspaceDir = path.join(tempDir, "workspace");
      const authorization = "Bearer beta5-access-token";
      const config = {
        mcp: {
          servers: {
            ducktape: {
              transport: "streamable-http",
              url: "https://agents.ducktape.xyz/mcp",
              headers: {
                Authorization: authorization,
                "x-tenant": "keep",
              },
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"];
      const request = vi.fn(async (method: string, _params: unknown) => {
        if (method === "thread/start") {
          return threadStartResult("thread-beta5");
        }
        if (method === "thread/resume") {
          return threadResumeResult("thread-beta5");
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const run = () =>
        startOrResumeThread({
          client: { request } as never,
          params: createParams(sessionFile, workspaceDir, config),
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createAppServerOptions(),
        });

      await run();
      const currentBinding = await readCodexAppServerBinding(sessionFile);
      expect(currentBinding).toBeDefined();

      const legacyFingerprint = JSON.stringify({
        mcp_servers: {
          ducktape: {
            http_headers: {
              Authorization: authorization,
              "x-tenant": "keep",
            },
            url: "https://agents.ducktape.xyz/mcp",
          },
        },
      });
      seedCodexTestBinding(sessionFile, {
        ...currentBinding!,
        userMcpServersFingerprint:
          legacyForm === "raw"
            ? legacyFingerprint
            : hashCodexAppServerBindingFingerprint(legacyFingerprint),
      });

      request.mockClear();
      await run();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
      const convergedBinding = await readCodexAppServerBinding(sessionFile);
      expect(convergedBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(convergedBinding?.userMcpServersFingerprint).not.toContain("beta5-access-token");
      expect(convergedBinding?.userMcpServersFingerprint).not.toBe(legacyFingerprint);
      expect(convergedBinding?.userMcpServersFingerprint).not.toBe(
        hashCodexAppServerBindingFingerprint(legacyFingerprint),
      );

      request.mockClear();
      await run();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    },
  );

  it("projects only Codex user MCP servers scoped to the current agent", async () => {
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
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            atlas: {
              transport: "streamable-http",
              url: "https://atlas.example.com/mcp",
              codex: {
                agents: ["atlas"],
                defaultToolsApprovalMode: "approve",
              },
            },
            apolo: {
              transport: "streamable-http",
              url: "https://apolo.example.com/mcp",
              codex: {
                agents: ["apolo"],
                defaultToolsApprovalMode: "approve",
              },
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      agentId: "atlas",
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toStrictEqual({
      atlas: {
        url: "https://atlas.example.com/mcp",
        default_tools_approval_mode: "approve",
      },
    });
  });

  it("omits mcp_servers from the start config when cfg has no user MCP servers", async () => {
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
      appServer: createAppServerOptions(),
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
  });

  it("omits user MCP servers when runtime policy disables native tool surfaces", async () => {
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
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            notes: {
              transport: "stdio",
              command: "node",
              args: ["/opt/notes-mcp/dist/index.js"],
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
  });

  it("starts a new thread when an existing binding lacks the matching user MCP fingerprint", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");

    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
    });

    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-restarted");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            notes: {
              transport: "stdio",
              command: "node",
              args: ["/opt/notes-mcp/dist/index.js"],
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    expect(request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(startParams?.config?.mcp_servers).toBeDefined();
    expect(startParams.config!.mcp_servers).toMatchObject({
      notes: { command: "node", args: ["/opt/notes-mcp/dist/index.js"] },
    });
  });

  it("does not resume an existing native thread when runtime policy disables native tools", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-native",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-restricted");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-native");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const startParams = request.mock.calls[0]?.[1] as {
      environments?: unknown[];
      config?: {
        "features.code_mode"?: boolean;
        "features.code_mode_only"?: boolean;
        mcp_servers?: Record<string, unknown>;
      };
    };
    expect(startParams?.environments).toEqual([]);
    expect(startParams?.config?.["features.code_mode"]).toBe(false);
    expect(startParams?.config?.["features.code_mode_only"]).toBe(false);
    expect(startParams?.config?.mcp_servers).toBeUndefined();
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-native");
  });

  it("preserves MCP-mismatched bindings across transient native-tool-disabled turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-native",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      mcpServersFingerprint: "mcp-v1",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-restricted");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      mcpServersFingerprint: undefined,
      mcpServersFingerprintEvaluated: true,
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const startParams = request.mock.calls[0]?.[1] as {
      config?: {
        "features.code_mode"?: boolean;
        mcp_servers?: Record<string, unknown>;
      };
    };
    expect(startParams?.config?.["features.code_mode"]).toBe(false);
    expect(startParams?.config?.mcp_servers).toBeUndefined();
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-native");
    expect(preservedBinding?.mcpServersFingerprint).toBe("mcp-v1");
  });

  it.each([
    {
      name: "legacy native MCP fingerprint",
      binding: { dynamicToolsFingerprint: "[]", mcpServersFingerprint: "mcp-v1" },
    },
    { name: "missing dynamic fingerprint", binding: {} },
  ])("rotates $name when scheduled dynamic MCP takes ownership", async ({ binding }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      ...binding,
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        // The successor is not authoritative until its exact-predecessor CAS commits.
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-legacy",
        });
        return threadStartResult("thread-scheduled-v1");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      configuredMcpOwnershipVersion: 1,
      mcpServersFingerprintEvaluated: true,
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-scheduled-v1",
      configuredMcpOwnershipVersion: 1,
    });
  });

  it("atomically alternates ordinary and scheduled ownership without evicting siblings", async () => {
    const sessionFile = path.join(tempDir, "session-alternating.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-alternating");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-ordinary-old",
      clientId: "client-old",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      mcpServersFingerprint: "mcp-v1",
      dynamicToolsFingerprint: "[]",
    });

    const released: string[] = [];
    const oldClient = {
      getInstanceId: () => "client-old",
      request: vi.fn(async (method: string, requestParams: { threadId?: string }) => {
        if (method === "thread/unsubscribe" && requestParams.threadId) {
          released.push(requestParams.threadId);
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(oldClient, { agentDir: workspaceDir });
    await retainCodexAppServerLiveThread(oldClient, "thread-ordinary-old");
    const releaseOldClientLease = vi.fn();
    sharedClientMocks.retainByInstanceId = (clientId) =>
      clientId === "client-old" ? { client: oldClient, release: releaseOldClientLease } : undefined;

    const successorIds = ["thread-scheduled-v1", "thread-ordinary-new", "thread-scheduled-v2"];
    const currentRequest = vi.fn(async (method: string, requestParams?: { threadId?: string }) => {
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId:
            successorIds.length === 3
              ? "thread-ordinary-old"
              : successorIds.length === 2
                ? "thread-scheduled-v1"
                : "thread-ordinary-new",
        });
        expect(released).toHaveLength(
          successorIds.length === 3 ? 0 : successorIds.length === 2 ? 1 : 2,
        );
        return threadStartResult(successorIds.shift()!);
      }
      if (method === "thread/unsubscribe" && requestParams?.threadId) {
        released.push(requestParams.threadId);
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const currentClient = {
      getInstanceId: () => "client-current",
      request: currentRequest,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(currentClient, { agentDir: workspaceDir });
    const releaseSibling = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(currentClient, "thread-sibling", releaseSibling);
    const common = {
      client: currentClient,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      mcpServersFingerprintEvaluated: true,
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    };

    const scheduledV1 = await startOrResumeThread({
      ...common,
      configuredMcpOwnershipVersion: 1,
    });
    expect(scheduledV1).toMatchObject({
      threadId: "thread-scheduled-v1",
      configuredMcpOwnershipVersion: 1,
    });
    expect(released).toEqual(["thread-ordinary-old"]);
    expect(releaseOldClientLease).toHaveBeenCalledOnce();
    await expect(
      consumeCodexAppServerLiveThread(oldClient, "thread-ordinary-old"),
    ).resolves.toBeUndefined();
    await retainCodexAppServerLiveThread(
      currentClient,
      scheduledV1.threadId,
      undefined,
      scheduledV1.liveThreadConfigFingerprint,
    );

    const ordinary = await startOrResumeThread({
      ...common,
      mcpServersFingerprint: "mcp-v2",
    });
    expect(ordinary).toMatchObject({ threadId: "thread-ordinary-new" });
    expect(ordinary.configuredMcpOwnershipVersion).toBeUndefined();
    expect(released).toEqual(["thread-ordinary-old", "thread-scheduled-v1"]);
    await expect(
      consumeCodexAppServerLiveThread(currentClient, "thread-scheduled-v1"),
    ).resolves.toBeUndefined();
    await retainCodexAppServerLiveThread(
      currentClient,
      ordinary.threadId,
      undefined,
      ordinary.liveThreadConfigFingerprint,
    );

    const scheduledV2 = await startOrResumeThread({
      ...common,
      configuredMcpOwnershipVersion: 1,
    });
    expect(scheduledV2).toMatchObject({
      threadId: "thread-scheduled-v2",
      configuredMcpOwnershipVersion: 1,
    });
    expect(released).toEqual(["thread-ordinary-old", "thread-scheduled-v1", "thread-ordinary-new"]);
    await expect(
      consumeCodexAppServerLiveThread(currentClient, "thread-ordinary-new"),
    ).resolves.toBeUndefined();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-scheduled-v2",
      clientId: "client-current",
      configuredMcpOwnershipVersion: 1,
    });

    const sibling = await consumeCodexAppServerLiveThread(currentClient, "thread-sibling");
    expect(sibling).toBeDefined();
    expect(releaseSibling).not.toHaveBeenCalled();
    await sibling?.release("thread-sibling");
    expect(releaseSibling).toHaveBeenCalledWith("thread-sibling");
  });

  it("preserves the configured-MCP predecessor when successor start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      clientId: "client-start-failure",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      mcpServersFingerprint: "mcp-v1",
      dynamicToolsFingerprint: "[]",
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        throw new Error("successor start failed");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-start-failure",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const releasePredecessor = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(client, "thread-legacy", releasePredecessor);

    await expect(
      startOrResumeThread({
        client,
        params: createParams(sessionFile, workspaceDir),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createAppServerOptions(),
        configuredMcpOwnershipVersion: 1,
        mcpServersFingerprintEvaluated: true,
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
      }),
    ).rejects.toThrow("successor start failed");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-legacy",
    });
    expect(releasePredecessor).not.toHaveBeenCalled();
    const predecessor = await consumeCodexAppServerLiveThread(client, "thread-legacy");
    expect(predecessor).toBeDefined();
    await predecessor?.release("thread-legacy");
  });

  it.each(["conflict", "error"] as const)(
    "cleans an uncommitted successor and preserves its predecessor after CAS $case",
    async (caseName) => {
      const sessionFile = path.join(tempDir, `session-${caseName}.jsonl`);
      const workspaceDir = path.join(tempDir, "workspace");
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-legacy",
        clientId: `client-cas-${caseName}`,
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        mcpServersFingerprint: "mcp-v1",
        dynamicToolsFingerprint: "[]",
      });
      const request = vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return threadStartResult("thread-uncommitted");
        }
        if (method === "thread/delete") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const client = {
        getInstanceId: () => `client-cas-${caseName}`,
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
      ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
      const releasePredecessor = vi.fn(async () => undefined);
      await retainCodexAppServerLiveThread(client, "thread-legacy", releasePredecessor);
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        mutate: async (identity, mutation) => {
          if (mutation.kind === "replace-thread") {
            if (caseName === "error") {
              throw new Error("lost replacement lease");
            }
            return false;
          }
          return await testCodexAppServerBindingStore.mutate(identity, mutation);
        },
      };

      await expect(
        startOrResumeThreadImpl({
          bindingStore,
          client,
          params: createParams(sessionFile, workspaceDir),
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createAppServerOptions(),
          configuredMcpOwnershipVersion: 1,
          mcpServersFingerprintEvaluated: true,
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
        }),
      ).rejects.toThrow(
        caseName === "error" ? "lost replacement lease" : "Codex thread binding changed",
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/start",
        "thread/delete",
      ]);
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-legacy",
      });
      expect(releasePredecessor).not.toHaveBeenCalled();
      const predecessor = await consumeCodexAppServerLiveThread(client, "thread-legacy");
      expect(predecessor).toBeDefined();
      await predecessor?.release("thread-legacy");
    },
  );

  it("cleans the successor and preserves the predecessor on post-start abort", async () => {
    const sessionFile = path.join(tempDir, "session-abort.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      clientId: "client-abort",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      mcpServersFingerprint: "mcp-v1",
      dynamicToolsFingerprint: "[]",
    });
    const controller = new AbortController();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        controller.abort("test abort");
        return threadStartResult("thread-uncommitted");
      }
      if (method === "thread/delete") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-abort",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const releasePredecessor = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(client, "thread-legacy", releasePredecessor);

    await expect(
      startOrResumeThread({
        client,
        params: createParams(sessionFile, workspaceDir),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createAppServerOptions(),
        configuredMcpOwnershipVersion: 1,
        mcpServersFingerprintEvaluated: true,
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/delete"]);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-legacy",
    });
    expect(releasePredecessor).not.toHaveBeenCalled();
    const predecessor = await consumeCodexAppServerLiveThread(client, "thread-legacy");
    expect(predecessor).toBeDefined();
    await predecessor?.release("thread-legacy");
  });

  it("preserves MCP-mismatched bindings when provider web-search support is unknown", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-native",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      webSearchThreadConfigFingerprint: "web-search-v1",
      mcpServersFingerprint: "mcp-v1",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fallback");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      mcpServersFingerprint: undefined,
      mcpServersFingerprintEvaluated: true,
      nativeProviderWebSearchSupport: "unknown",
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-native");
    expect(preservedBinding?.mcpServersFingerprint).toBe("mcp-v1");
  });

  it("starts a new thread without user MCP servers when runtime policy disables them", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const config = {
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: "node",
            args: ["/opt/notes-mcp/dist/index.js"],
          },
        },
      },
    } as unknown as EmbeddedRunAttemptParams["config"];
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-started");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    request.mockClear();

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const startParams = request.mock.calls[0]?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
  });

  it("starts a new thread when a user MCP Authorization bearer changes without storing the bearer", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const createConfig = (authorization: string) =>
      ({
        mcp: {
          servers: {
            ducktape: {
              transport: "streamable-http",
              url: "https://agents.ducktape.xyz/mcp",
              headers: {
                Authorization: authorization,
                "x-tenant": "keep",
              },
            },
          },
        },
      }) as unknown as EmbeddedRunAttemptParams["config"];
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-with-current-bearer");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-with-stale-bearer");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, createConfig("Bearer access-token-one")),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });
    const firstBinding = await readCodexAppServerBinding(sessionFile);
    expect(firstBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstBinding?.userMcpServersFingerprint).not.toContain("access-token-one");

    request.mockClear();

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, createConfig("Bearer access-token-two")),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const startParams = request.mock.calls[0]?.[1] as {
      config?: { mcp_servers?: Record<string, { http_headers?: Record<string, string> }> };
    };
    expect(startParams?.config?.mcp_servers?.ducktape?.http_headers?.Authorization).toBe(
      "Bearer access-token-two",
    );
    const secondBinding = await readCodexAppServerBinding(sessionFile);
    expect(secondBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(secondBinding?.userMcpServersFingerprint).not.toContain("access-token-two");
    expect(secondBinding?.userMcpServersFingerprint).not.toBe(
      firstBinding?.userMcpServersFingerprint,
    );
  });

  it("omits MCP OAuth servers instead of sending bearers to a remote app-server", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-without-oauth-mcp");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            ducktape: {
              transport: "streamable-http",
              url: "https://agents.ducktape.xyz/mcp",
              auth: "oauth",
              oauth: { authProfileId: "ducktape:mcp" },
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: {
        ...createAppServerOptions(),
        connectionClass: "remote",
      },
    });

    const startParams = request.mock.calls[0]?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
  });

  it("resends user MCP config when resuming a thread with the matching fingerprint", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const config = {
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: "node",
            args: ["/opt/notes-mcp/dist/index.js"],
          },
        },
      },
    } as unknown as EmbeddedRunAttemptParams["config"];
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-with-user-mcp");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-with-user-mcp");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    request.mockClear();

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const resumeCall = request.mock.calls.find(([method]) => method === "thread/resume");
    const resumeParams = resumeCall?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(resumeCall).toBeDefined();
    expect(resumeParams?.config?.mcp_servers).toMatchObject({
      notes: { command: "node", args: ["/opt/notes-mcp/dist/index.js"] },
    });
  });
});
