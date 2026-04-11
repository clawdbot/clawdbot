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

function createContext(args: string, sessionFile?: string): PluginCommandContext {
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
      filter: "fix",
    });
  });
});
