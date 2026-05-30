import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovals: vi.fn<() => ExecApprovalsFile>(() => ({ version: 1, agents: {} })),
}));

const agentRuntimeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveDefaultAgentDir: vi.fn(() => "/agent"),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string, _lookup?: { config?: unknown }) => provider),
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  saveAuthProfileStore: vi.fn(),
}));

const codexRequirementsTomlMock = vi.hoisted(() => vi.fn<() => string | undefined>());
const resolveSandboxContextMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ enabled: boolean } | null>>(async () => null),
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync(filePath: string | URL | number, options?: BufferEncoding | object | null) {
      if (filePath === "/etc/codex/requirements.toml") {
        const content = codexRequirementsTomlMock();
        if (content !== undefined) {
          return content;
        }
      }
      return actual.readFileSync(filePath, options);
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    resolveSandboxContext: resolveSandboxContextMock,
  };
});

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/exec-approvals-runtime")>();
  return {
    ...actual,
    loadExecApprovals: execApprovalsRuntimeMocks.loadExecApprovals,
  };
});
vi.mock("openclaw/plugin-sdk/agent-runtime", () => agentRuntimeMocks);

import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
  startCodexConversationThread,
} from "./conversation-binding.js";

let tempDir: string;

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

describe("codex conversation binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({ version: 1, agents: {} });
    agentRuntimeMocks.ensureAuthProfileStore.mockReset();
    agentRuntimeMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    agentRuntimeMocks.resolveApiKeyForProfile.mockReset();
    agentRuntimeMocks.resolveAuthProfileOrder.mockReset();
    agentRuntimeMocks.resolveDefaultAgentDir.mockClear();
    agentRuntimeMocks.resolvePersistedAuthProfileOwnerAgentDir.mockReset();
    agentRuntimeMocks.resolveProviderIdForAuth.mockClear();
    agentRuntimeMocks.resolveSessionAgentIds.mockClear();
    agentRuntimeMocks.saveAuthProfileStore.mockReset();
    codexRequirementsTomlMock.mockReset();
    resolveSandboxContextMock.mockReset();
    resolveSandboxContextMock.mockResolvedValue(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue([]);
    agentRuntimeMocks.resolveDefaultAgentDir.mockReturnValue("/agent");
    agentRuntimeMocks.resolveProviderIdForAuth.mockImplementation(
      (provider: string, _lookup?: { config?: unknown }) => provider,
    );
    agentRuntimeMocks.resolveSessionAgentIds.mockReturnValue({
      defaultAgentId: "main",
      sessionAgentId: "main",
    });
  });

  it("uses the default Codex auth profile and omits the public OpenAI provider for new binds", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const config = {
      auth: { order: { "openai-codex": ["openai-codex:default"] } },
    };
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
        },
      },
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue(["openai-codex:default"]);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await startCodexConversationThread({
      config: config as never,
      sessionFile,
      workspaceDir: tempDir,
      model: "gpt-5.4-mini",
      modelProvider: "openai",
    });

    const authOrderParams = mockCallArg(agentRuntimeMocks.resolveAuthProfileOrder) as {
      cfg?: unknown;
      provider?: unknown;
    };
    expect(authOrderParams?.cfg).toBe(config);
    expect(authOrderParams?.provider).toBe("openai-codex");
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("openai-codex:default");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[0]?.params.personality).toBe("none");
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    await expect(fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8")).resolves.toContain(
      '"authProfileId": "openai-codex:default"',
    );
  });

  it("preserves Codex auth and omits the public OpenAI provider for native bind threads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        work: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-old",
        cwd: tempDir,
        authProfileId: "work",
        modelProvider: "openai",
      }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
          modelProvider: "openai",
        };
      }),
    });

    await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
      model: "gpt-5.4-mini",
      modelProvider: "openai",
    });

    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("work");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[0]?.params.personality).toBe("none");
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    await expect(fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8")).resolves.toContain(
      '"authProfileId": "work"',
    );
    await expect(
      fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    ).resolves.not.toContain('"modelProvider": "openai"');
  });

  it("stores and uses the owning agent dir for bound app-server sessions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({
        thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
        model: "gpt-5.4-mini",
      })),
    });

    const data = await startCodexConversationThread({
      sessionFile,
      workspaceDir: tempDir,
      agentDir,
      model: "gpt-5.4-mini",
    });

    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      agentDir?: unknown;
    };
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(data.agentDir).toBe(agentDir);
  });

  it("rejects binding when configured exec auto mode may need unrouted human approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        } as never,
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("rejects binding when configured exec ask mode needs unrouted user approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        config: {
          tools: {
            exec: {
              mode: "ask",
            },
          },
        } as never,
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("applies host exec approval floors to configless native bind threads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({
      version: 1,
      defaults: {
        security: "deny",
        ask: "off",
      },
      agents: {},
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        return {
          thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
          model: "gpt-5.4-mini",
        };
      }),
    });

    await expect(
      startCodexConversationThread({
        sessionFile,
        workspaceDir: tempDir,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow("tools.exec.mode=deny");
    expect(execApprovalsRuntimeMocks.loadExecApprovals).toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("clears the Codex app-server sidecar when a pending bind is denied", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sidecar = `${sessionFile}.codex-app-server.json`;
    await fs.writeFile(sidecar, JSON.stringify({ schemaVersion: 1, threadId: "thread-1" }));

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile,
          workspaceDir: tempDir,
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
        },
      },
    });

    await expect(fs.stat(sidecar)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("consumes inbound bound messages when command authorization is absent", async () => {
    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile: path.join(tempDir, "session.jsonl"),
            workspaceDir: tempDir,
          },
        },
      },
    );

    expect(result).toEqual({ handled: true });
  });

  it("routes bound Codex CLI node sessions through node resume", async () => {
    const resumeCodexCliSessionOnNode = vi.fn(async () => ({
      ok: true as const,
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      text: "done",
    }));

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "node-session",
      },
      {
        channelId: "discord",
        sessionKey: "node-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "mb-m5",
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
          },
        },
      },
      {
        config: { tools: { exec: { host: "node", node: "mb-m5" } } },
        resumeCodexCliSessionOnNode,
        timeoutMs: 1234,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(resumeCodexCliSessionOnNode).toHaveBeenCalledWith({
      nodeId: "mb-m5",
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      prompt: "continue the task",
      cwd: "/repo",
      timeoutMs: 1234,
    });
  });

  it("blocks bound Codex app-server turns when the current OpenClaw session is sandboxed", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-1", cwd: tempDir }),
    );

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "sandboxed-session",
      },
      {
        channelId: "discord",
        sessionKey: "sandboxed-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex app-server conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
        ),
      },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("blocks bound Codex app-server turns when exec host=node is active", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-1", cwd: tempDir }),
    );

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "node-session",
      },
      {
        channelId: "discord",
        sessionKey: "node-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex app-server conversation binding is unavailable because OpenClaw exec host=node is active for this session.",
        ),
      },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("blocks bound Codex CLI node turns when the current OpenClaw session is sandboxed", async () => {
    const resumeCodexCliSessionOnNode = vi.fn();

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "sandboxed-session",
      },
      {
        channelId: "discord",
        sessionKey: "sandboxed-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "mb-m5",
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
          },
        },
      },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        resumeCodexCliSessionOnNode,
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex CLI node conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
        ),
      },
    });
    expect(resumeCodexCliSessionOnNode).not.toHaveBeenCalled();
  });

  it("recreates a missing bound thread and preserves auth plus turn overrides", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        work: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
        },
      },
    });
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-old",
        cwd: tempDir,
        authProfileId: "work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceTier: "fast",
      }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.4-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [
                      {
                        id: "assistant-1",
                        type: "agentMessage",
                        text: "Recovered",
                      },
                    ],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Recovered" } });
    expect(requests.map((request) => request.method)).toEqual([
      "turn/start",
      "thread/start",
      "turn/start",
    ]);
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams?.authProfileId).toBe("work");
    expect(requests[1]?.params.model).toBe("gpt-5.4-mini");
    expect(requests[1]?.params.approvalPolicy).toBe("on-request");
    expect(requests[1]?.params.sandbox).toBe("workspace-write");
    expect(requests[1]?.params.serviceTier).toBe("priority");
    expect(requests[1]?.params).not.toHaveProperty("modelProvider");
    expect(requests[2]?.params.threadId).toBe("thread-new");
    expect(requests[2]?.params.approvalPolicy).toBe("on-request");
    expect(requests[2]?.params.serviceTier).toBe("priority");
    const savedBinding = JSON.parse(
      await fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    );
    expect(savedBinding.threadId).toBe("thread-new");
    expect(savedBinding.authProfileId).toBe("work");
    expect(savedBinding.approvalPolicy).toBe("on-request");
    expect(savedBinding.sandbox).toBe("workspace-write");
    expect(savedBinding.serviceTier).toBe("priority");
    expect(savedBinding).not.toHaveProperty("modelProvider");
  });

  it("does not silently decline auto-mode approvals during missing thread recovery", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-old",
        cwd: tempDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.4-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Recovered" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 500,
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(requests).toEqual([]);
  });

  it("creates a fresh thread when recovery finds the binding already cleared", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.5-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Recovered fresh" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "redacted-group",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Recovered fresh" } });
    expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
    expect(requests[1]?.params.threadId).toBe("thread-new");
    expect(requests[1]?.params.personality).toBe("none");
    const savedBinding = JSON.parse(
      await fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    );
    expect(savedBinding.threadId).toBe("thread-new");
  });

  it("passes sandbox state when resolving bound turn policy", async () => {
    codexRequirementsTomlMock.mockReturnValue(
      [
        'allowed_sandbox_modes = ["read-only", "workspace-write"]',
        'allowed_approval_policies = ["never", "on-request"]',
        'allowed_approvals_reviewers = ["user"]',
      ].join("\n"),
    );
    resolveSandboxContextMock.mockResolvedValue({ enabled: true });
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue",
        bodyForAgent: "continue",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
        sessionKey: "agent:main:session-1",
      },
      {
        channelId: "telegram",
        sessionKey: "agent:main:session-1",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 50,
        config: {
          tools: {
            exec: {
              security: "full",
              ask: "on-miss",
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(result?.reply?.text).not.toContain(
      "legacy full exec security with ask requires Codex app-server danger-full-access",
    );
    expect(resolveSandboxContextMock).toHaveBeenCalledWith({
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "on-miss",
          },
        },
      },
      sessionKey: "agent:main:session-1",
      workspaceDir: tempDir,
    });
    expect(turnStartParams).toEqual([]);
  });

  it("returns a clean failure reply when app-server turn start rejects", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-b", "agent");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
        authProfileId: "openai-codex:work",
      }),
    );
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "turn/start") {
          throw new Error(
            "unexpected status 401 Unauthorized: Missing bearer <@U123> [trusted](https://evil) @here",
          );
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    try {
      const result = await handleCodexConversationInboundClaim(
        {
          content: "hi",
          bodyForAgent: "hi",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: tempDir,
              agentDir,
            },
          },
        },
        { timeoutMs: 50 },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(result).toEqual({
        handled: true,
        reply: {
          text: "Codex app-server turn failed: unexpected status 401 Unauthorized: Missing bearer &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
        },
      });
      const replyText = result?.reply?.text ?? "";
      expect(replyText).not.toContain("<@U123>");
      expect(replyText).not.toContain("[trusted](https://evil)");
      expect(replyText).not.toContain("@here");
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("falls back to content when the channel body for agent is blank", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-b", "agent");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "use the fallback prompt",
        bodyForAgent: "",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentDir,
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      agentDir?: unknown;
    };
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(turnStartParams[0]?.input).toEqual([
      { type: "text", text: "use the fallback prompt", text_elements: [] },
    ]);
    expect(turnStartParams[0]?.approvalPolicy).toBe("never");
    expect(turnStartParams[0]?.approvalsReviewer).toBe("user");
    expect(turnStartParams[0]?.sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    });
  });
});
