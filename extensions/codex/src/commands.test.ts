import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import { resetSharedCodexAppServerClientForTests } from "./app-server/shared-client.js";
import type { CodexCommandDeps } from "./command-handlers.js";
import { handleCodexCommand } from "./commands.js";

let tempDir: string;

function createContext(
  args: string,
  sessionFile?: string,
  overrides: Partial<PluginCommandContext> = {},
): PluginCommandContext {
  return {
    channel: "test",
    isAuthorizedSender: true,
    args,
    commandBody: `/codex ${args}`,
    config: {},
    sessionFile,
    requestConversationBinding: async () => ({ status: "error", message: "unused" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

function createDeps(overrides: Partial<CodexCommandDeps> = {}): Partial<CodexCommandDeps> {
  return {
    codexControlRequest: vi.fn(),
    listCodexAppServerModels: vi.fn(),
    readCodexStatusProbes: vi.fn(),
    requestOptions: vi.fn((_pluginConfig: unknown, limit: number) => ({
      limit,
      timeoutMs: 1000,
      startOptions: {
        transport: "stdio",
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      } satisfies CodexAppServerStartOptions,
    })),
    safeCodexControlRequest: vi.fn(),
    ...overrides,
  };
}

describe("codex command", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-command-"));
  });

  afterEach(async () => {
    resetSharedCodexAppServerClientForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("attaches the current session to an existing Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: unknown }> = [];
    const deps = createDeps({
      codexControlRequest: vi.fn(
        async (_pluginConfig: unknown, method: string, requestParams: unknown) => {
          requests.push({ method, params: requestParams });
          return {
            thread: { id: "thread-123", cwd: "/repo" },
            model: "gpt-5.4",
            modelProvider: "openai",
          };
        },
      ),
    });

    await expect(
      handleCodexCommand(createContext("resume thread-123", sessionFile), { deps }),
    ).resolves.toEqual({
      text: "Attached this OpenClaw session to Codex thread thread-123.",
    });

    expect(requests).toEqual([
      {
        method: "thread/resume",
        params: { threadId: "thread-123", persistExtendedHistory: true },
      },
    ]);
    await expect(fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8")).resolves.toContain(
      '"threadId": "thread-123"',
    );
  });

  it("shows model ids from Codex app-server", async () => {
    const deps = createDeps({
      listCodexAppServerModels: vi.fn(async () => ({
        models: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["medium"],
          },
        ],
      })),
    });

    await expect(handleCodexCommand(createContext("models"), { deps })).resolves.toEqual({
      text: "Codex models:\n- gpt-5.4",
    });
  });

  it("shows when Codex app-server model output is truncated", async () => {
    const deps = createDeps({
      listCodexAppServerModels: vi.fn(async () => ({
        models: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["medium"],
          },
        ],
        nextCursor: "page-2",
        truncated: true,
      })),
    });

    await expect(handleCodexCommand(createContext("models"), { deps })).resolves.toEqual({
      text: "Codex models:\n- gpt-5.4\n- More models available; output truncated.",
    });
  });

  it("reports status unavailable when every Codex probe fails", async () => {
    const offline = { ok: false as const, error: "offline" };
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: offline,
        account: offline,
        limits: offline,
        mcps: offline,
        skills: offline,
      })),
    });

    await expect(handleCodexCommand(createContext("status"), { deps })).resolves.toEqual({
      text: [
        "Codex app-server: unavailable",
        "Models: offline",
        "Account: offline",
        "Rate limits: offline",
        "MCP servers: offline",
        "Skills: offline",
      ].join("\n"),
    });
  });

  it("formats generated account/read responses", async () => {
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "chatgpt", email: "codex@example.com", planType: "pro" },
          requiresOpenaiAuth: false,
        },
      })
      .mockResolvedValueOnce({ ok: true, value: { data: [{ name: "primary" }] } });

    await expect(
      handleCodexCommand(createContext("account"), {
        deps: createDeps({ safeCodexControlRequest }),
      }),
    ).resolves.toEqual({
      text: ["Account: codex@example.com", "Rate limits: 1"].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledWith(undefined, CODEX_CONTROL_METHODS.account, {
      refreshToken: false,
    });
  });

  it("formats generated Amazon Bedrock account responses", async () => {
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { account: { type: "amazonBedrock" }, requiresOpenaiAuth: false },
      })
      .mockResolvedValueOnce({ ok: true, value: [] });

    await expect(
      handleCodexCommand(createContext("account"), {
        deps: createDeps({ safeCodexControlRequest }),
      }),
    ).resolves.toEqual({
      text: ["Account: Amazon Bedrock", "Rate limits: none returned"].join("\n"),
    });
  });

  it("starts compaction for the attached Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-123", cwd: "/repo" }),
    );
    const codexControlRequest = vi.fn(async () => ({}));
    const deps = createDeps({
      codexControlRequest,
    });

    await expect(
      handleCodexCommand(createContext("compact", sessionFile), { deps }),
    ).resolves.toEqual({
      text: "Started Codex compaction for thread thread-123.",
    });
    expect(codexControlRequest).toHaveBeenCalledWith(undefined, CODEX_CONTROL_METHODS.compact, {
      threadId: "thread-123",
    });
  });

  it("starts review with the generated app-server target shape", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-123", cwd: "/repo" }),
    );
    const codexControlRequest = vi.fn(async () => ({}));

    await expect(
      handleCodexCommand(createContext("review", sessionFile), {
        deps: createDeps({ codexControlRequest }),
      }),
    ).resolves.toEqual({
      text: "Started Codex review for thread thread-123.",
    });
    expect(codexControlRequest).toHaveBeenCalledWith(undefined, CODEX_CONTROL_METHODS.review, {
      threadId: "thread-123",
      target: { type: "uncommittedChanges" },
    });
  });

  it("explains compaction when no Codex thread is attached", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");

    await expect(
      handleCodexCommand(createContext("compact", sessionFile), { deps: createDeps() }),
    ).resolves.toEqual({
      text: "No Codex thread is attached to this OpenClaw session yet.",
    });
  });

  it("passes filters to Codex thread listing", async () => {
    const codexControlRequest = vi.fn(async () => ({
      data: [{ id: "thread-123", title: "Fix the thing", model: "gpt-5.4", cwd: "/repo" }],
    }));
    const deps = createDeps({
      codexControlRequest,
    });

    await expect(handleCodexCommand(createContext("threads fix"), { deps })).resolves.toEqual({
      text: [
        "Codex threads:",
        "- thread-123 - Fix the thing (gpt-5.4, /repo)",
        "  Resume: /codex resume thread-123",
      ].join("\n"),
    });
    expect(codexControlRequest).toHaveBeenCalledWith(undefined, CODEX_CONTROL_METHODS.listThreads, {
      limit: 10,
      searchTerm: "fix",
    });
  });

  it("binds the current conversation to a Codex app-server thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-123", cwd: "/repo" }),
    );
    const startCodexConversationThread = vi.fn(async () => ({
      kind: "codex-app-server-session" as const,
      version: 1 as const,
      sessionFile,
      workspaceDir: "/repo",
    }));
    const requestConversationBinding = vi.fn(async () => ({
      status: "bound" as const,
      binding: {
        bindingId: "binding-1",
        pluginId: "codex",
        pluginRoot: "/plugin",
        channel: "test",
        accountId: "default",
        conversationId: "conversation",
        boundAt: 1,
      },
    }));

    await expect(
      handleCodexCommand(
        createContext(
          "bind thread-123 --cwd /repo --model gpt-5.4 --provider openai",
          sessionFile,
          {
            requestConversationBinding,
          },
        ),
        {
          deps: createDeps({
            startCodexConversationThread,
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Bound this conversation to Codex thread thread-123 in /repo.",
    });
    expect(startCodexConversationThread).toHaveBeenCalledWith({
      pluginConfig: undefined,
      sessionFile,
      workspaceDir: "/repo",
      threadId: "thread-123",
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    expect(requestConversationBinding).toHaveBeenCalledWith({
      summary: "Codex app-server thread thread-123 in /repo",
      detachHint: "/codex detach",
      data: {
        kind: "codex-app-server-session",
        version: 1,
        sessionFile,
        workspaceDir: "/repo",
      },
    });
  });

  it("returns the binding approval reply when conversation bind needs approval", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const reply = { text: "Approve this?" };
    await expect(
      handleCodexCommand(
        createContext("bind", sessionFile, {
          requestConversationBinding: async () => ({
            status: "pending",
            approvalId: "approval-1",
            reply,
          }),
        }),
        {
          deps: createDeps({
            startCodexConversationThread: vi.fn(async () => ({
              kind: "codex-app-server-session" as const,
              version: 1 as const,
              sessionFile,
              workspaceDir: "/default",
            })),
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual(reply);
  });

  it("clears the Codex app-server thread binding when conversation bind fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const clearCodexAppServerBinding = vi.fn(async () => {});

    await expect(
      handleCodexCommand(
        createContext("bind", sessionFile, {
          requestConversationBinding: async () => ({
            status: "error",
            message: "binding unsupported",
          }),
        }),
        {
          deps: createDeps({
            clearCodexAppServerBinding,
            startCodexConversationThread: vi.fn(async () => ({
              kind: "codex-app-server-session" as const,
              version: 1 as const,
              sessionFile,
              workspaceDir: "/default",
            })),
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({ text: "binding unsupported" });
    expect(clearCodexAppServerBinding).toHaveBeenCalledWith(sessionFile);
  });

  it("detaches the current conversation and clears the Codex app-server thread binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const clearCodexAppServerBinding = vi.fn(async () => {});
    const detachConversationBinding = vi.fn(async () => ({ removed: true }));

    await expect(
      handleCodexCommand(
        createContext("detach", sessionFile, {
          detachConversationBinding,
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: "/plugin",
            channel: "test",
            accountId: "default",
            conversationId: "conversation",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: "/repo",
            },
          }),
        }),
        { deps: createDeps({ clearCodexAppServerBinding }) },
      ),
    ).resolves.toEqual({
      text: "Detached this conversation from Codex.",
    });
    expect(detachConversationBinding).toHaveBeenCalled();
    expect(clearCodexAppServerBinding).toHaveBeenCalledWith(sessionFile);
  });

  it("stops the active bound Codex turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const stopCodexConversationTurn = vi.fn(async () => ({
      stopped: true,
      message: "Codex stop requested.",
    }));

    await expect(
      handleCodexCommand(createContext("stop", sessionFile), {
        deps: createDeps({ stopCodexConversationTurn }),
      }),
    ).resolves.toEqual({ text: "Codex stop requested." });
    expect(stopCodexConversationTurn).toHaveBeenCalledWith({
      sessionFile,
      pluginConfig: undefined,
    });
  });

  it("steers the active bound Codex turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const steerCodexConversationTurn = vi.fn(async () => ({
      steered: true,
      message: "Sent steer message to Codex.",
    }));

    await expect(
      handleCodexCommand(createContext("steer focus tests first", sessionFile), {
        deps: createDeps({ steerCodexConversationTurn }),
      }),
    ).resolves.toEqual({ text: "Sent steer message to Codex." });
    expect(steerCodexConversationTurn).toHaveBeenCalledWith({
      sessionFile,
      pluginConfig: undefined,
      message: "focus tests first",
    });
  });

  it("sets per-binding model, fast mode, and permissions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const setCodexConversationModel = vi.fn(async () => "Codex model set to gpt-5.4.");
    const setCodexConversationFastMode = vi.fn(async () => "Codex fast mode enabled.");
    const setCodexConversationPermissions = vi.fn(
      async () => "Codex permissions set to full access.",
    );
    const deps = createDeps({
      setCodexConversationModel,
      setCodexConversationFastMode,
      setCodexConversationPermissions,
    });

    await expect(
      handleCodexCommand(createContext("model gpt-5.4", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Codex model set to gpt-5.4." });
    await expect(
      handleCodexCommand(createContext("fast on", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Codex fast mode enabled." });
    await expect(
      handleCodexCommand(createContext("permissions yolo", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Codex permissions set to full access." });

    expect(setCodexConversationModel).toHaveBeenCalledWith({
      sessionFile,
      pluginConfig: undefined,
      model: "gpt-5.4",
    });
    expect(setCodexConversationFastMode).toHaveBeenCalledWith({
      sessionFile,
      pluginConfig: undefined,
      enabled: true,
    });
    expect(setCodexConversationPermissions).toHaveBeenCalledWith({
      sessionFile,
      pluginConfig: undefined,
      mode: "yolo",
    });
  });

  it("uses current plugin binding data for follow-up control commands", async () => {
    const hostSessionFile = path.join(tempDir, "host-session.jsonl");
    const pluginSessionFile = path.join(tempDir, "plugin-session.jsonl");
    const setCodexConversationFastMode = vi.fn(async () => "Codex fast mode enabled.");

    await expect(
      handleCodexCommand(
        createContext("fast on", pluginSessionFile, {
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: "/plugin",
            channel: "slack",
            accountId: "default",
            conversationId: "user:U123",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile: hostSessionFile,
              workspaceDir: tempDir,
            },
          }),
        }),
        {
          deps: createDeps({
            setCodexConversationFastMode,
          }),
        },
      ),
    ).resolves.toEqual({ text: "Codex fast mode enabled." });

    expect(setCodexConversationFastMode).toHaveBeenCalledWith({
      sessionFile: hostSessionFile,
      pluginConfig: undefined,
      enabled: true,
    });
  });

  it("describes active binding preferences", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123",
        cwd: "/repo",
        model: "gpt-5.4",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );

    await expect(
      handleCodexCommand(
        createContext("binding", sessionFile, {
          getCurrentConversationBinding: async () => ({
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: "/plugin",
            channel: "test",
            accountId: "default",
            conversationId: "conversation",
            boundAt: 1,
            data: {
              kind: "codex-app-server-session",
              version: 1,
              sessionFile,
              workspaceDir: "/repo",
            },
          }),
        }),
        {
          deps: createDeps({
            readCodexConversationActiveTurn: vi.fn(() => ({
              sessionFile,
              threadId: "thread-123",
              turnId: "turn-1",
            })),
          }),
        },
      ),
    ).resolves.toEqual({
      text: [
        "Codex conversation binding:",
        "- Thread: thread-123",
        "- Workspace: /repo",
        "- Model: gpt-5.4",
        "- Fast: on",
        "- Permissions: full access",
        "- Active run: turn-1",
        `- Session: ${sessionFile}`,
      ].join("\n"),
    });
  });
});
