// Codex tests cover thread lifecycle.user mcp servers plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";

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
