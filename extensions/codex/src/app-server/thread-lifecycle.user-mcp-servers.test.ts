import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { readCodexAppServerBinding, writeCodexAppServerBinding } from "./session-binding.js";
import { startOrResumeThread } from "./thread-lifecycle.js";

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
