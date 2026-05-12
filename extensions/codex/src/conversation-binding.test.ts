import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

const agentRuntimeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveDefaultAgentDir: vi.fn(() => "/agent"),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string) => provider),
  saveAuthProfileStore: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => sharedClientMocks);
vi.mock("openclaw/plugin-sdk/agent-runtime", () => agentRuntimeMocks);

import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
  startCodexConversationThread,
} from "./conversation-binding.js";

let tempDir: string;

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call.at(argIndex);
}

describe("codex conversation binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    agentRuntimeMocks.ensureAuthProfileStore.mockReset();
    agentRuntimeMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    agentRuntimeMocks.resolveApiKeyForProfile.mockReset();
    agentRuntimeMocks.resolveAuthProfileOrder.mockReset();
    agentRuntimeMocks.resolveDefaultAgentDir.mockClear();
    agentRuntimeMocks.resolvePersistedAuthProfileOwnerAgentDir.mockReset();
    agentRuntimeMocks.resolveProviderIdForAuth.mockClear();
    agentRuntimeMocks.saveAuthProfileStore.mockReset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue([]);
    agentRuntimeMocks.resolveDefaultAgentDir.mockReturnValue("/agent");
    agentRuntimeMocks.resolveProviderIdForAuth.mockImplementation((provider: string) => provider);
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
    expect(requests[0]?.params).not.toHaveProperty("modelProvider");
    await expect(fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8")).resolves.toContain(
      '"authProfileId": "work"',
    );
    await expect(
      fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    ).resolves.not.toContain('"modelProvider": "openai"');
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

  it("returns a clean failure reply when app-server turn start rejects", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
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
          },
        },
      },
      { timeoutMs: 50 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(turnStartParams[0]?.input).toEqual([
      { type: "text", text: "use the fallback prompt", text_elements: [] },
    ]);
  });
});
