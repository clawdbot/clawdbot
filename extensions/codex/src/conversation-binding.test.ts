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
  resolveOpenClawAgentDir: vi.fn(() => "/agent"),
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
    agentRuntimeMocks.resolveOpenClawAgentDir.mockClear();
    agentRuntimeMocks.resolvePersistedAuthProfileOwnerAgentDir.mockReset();
    agentRuntimeMocks.resolveProviderIdForAuth.mockClear();
    agentRuntimeMocks.saveAuthProfileStore.mockReset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue([]);
    agentRuntimeMocks.resolveOpenClawAgentDir.mockReturnValue("/agent");
    agentRuntimeMocks.resolveProviderIdForAuth.mockImplementation((provider: string) => provider);
  });

  it("uses the default Codex auth profile and omits the public OpenAI provider for new binds", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const config = { auth: { order: { "openai-codex": ["openai-codex:default"] } } };
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
          thread: { id: "thread-new", cwd: tempDir },
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

    expect(agentRuntimeMocks.resolveAuthProfileOrder).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: config, provider: "openai-codex" }),
    );
    expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai-codex:default" }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "thread/start",
      params: expect.objectContaining({ model: "gpt-5.4-mini" }),
    });
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
          thread: { id: "thread-new", cwd: tempDir },
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

    expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "work" }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "thread/start",
      params: expect.objectContaining({ model: "gpt-5.4-mini" }),
    });
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

    await expect(fs.stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
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
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
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
          text: "Codex app-server turn failed: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        },
      });
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
