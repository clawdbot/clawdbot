import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexComputerUseStatus } from "./app-server/computer-use.js";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import {
  readRecentCodexRateLimits,
  resetCodexRateLimitCacheForTests,
} from "./app-server/rate-limit-cache.js";
import { resetSharedCodexAppServerClientForTests } from "./app-server/shared-client.js";
import {
  resetCodexDiagnosticsFeedbackStateForTests,
  type CodexCommandDeps,
} from "./command-handlers.js";
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
    senderIsOwner: true,
    senderId: "user-1",
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
    requestOptions: vi.fn(
      (
        _pluginConfig: unknown,
        limit: number,
        config?: Parameters<NonNullable<CodexCommandDeps["requestOptions"]>>[2],
      ) => ({
        limit,
        timeoutMs: 1000,
        startOptions: {
          transport: "stdio",
          command: "codex",
          args: ["app-server", "--listen", "stdio://"],
          headers: {},
        } satisfies CodexAppServerStartOptions,
        config,
      }),
    ),
    safeCodexControlRequest: vi.fn(),
    ...overrides,
  };
}

function readDiagnosticsConfirmationToken(
  result: PluginCommandResult,
  commandPrefix = "/codex diagnostics",
): string {
  const text = result.text ?? "";
  const token = new RegExp(`${escapeRegExp(commandPrefix)} confirm ([a-f0-9]{12})`).exec(text)?.[1];
  expect(token).toBeTruthy();
  return token as string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectedDiagnosticsTargetBlock(params: {
  index?: number;
  channel?: string;
  sessionKey?: string;
  sessionId?: string;
  threadId: string;
}): string[] {
  return [
    `Session ${params.index ?? 1}`,
    ...(params.channel ? [`Channel: ${params.channel}`] : []),
    ...(params.sessionKey ? [`OpenClaw session key: \`${params.sessionKey}\``] : []),
    ...(params.sessionId ? [`OpenClaw session id: \`${params.sessionId}\``] : []),
    `Codex thread id: \`${params.threadId}\``,
    `Inspect locally: \`codex resume ${params.threadId}\``,
  ];
}

describe("codex command", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-command-"));
  });

  afterEach(async () => {
    resetCodexDiagnosticsFeedbackStateForTests();
    resetCodexRateLimitCacheForTests();
    resetSharedCodexAppServerClientForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("escapes unknown subcommands before chat display", async () => {
    const result = await handleCodexCommand(createContext("<@U123> [trusted](https://evil) @here"));

    expect(result.text).toContain("Unknown Codex command: &lt;\uff20U123&gt;");
    expect(result.text).not.toContain("<@U123>");
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

  it("rejects malformed resume commands before attaching a Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const codexControlRequest = vi.fn();
    const writeCodexAppServerBinding = vi.fn();

    await expect(
      handleCodexCommand(createContext("resume thread-123 extra", sessionFile), {
        deps: createDeps({ codexControlRequest, writeCodexAppServerBinding }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex resume <thread-id>",
    });
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(writeCodexAppServerBinding).not.toHaveBeenCalled();
  });

  it("escapes resumed Codex thread ids before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const unsafe = "thread-123 <@U123> [trusted](https://evil)";
    const deps = createDeps({
      codexControlRequest: vi.fn(async () => ({
        thread: { id: unsafe, cwd: "/repo" },
      })),
    });

    const result = await handleCodexCommand(createContext("resume thread-123", sessionFile), {
      deps,
    });

    expect(result.text).toContain(
      "thread-123 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });

  it("shows model ids from Codex app-server", async () => {
    const config = { auth: { order: { "openai-codex": ["openai-codex:work"] } } };
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

    await expect(
      handleCodexCommand(createContext("models", undefined, { config }), { deps }),
    ).resolves.toEqual({
      text: "Codex models:\n- gpt-5.4",
    });
    expect(deps.requestOptions).toHaveBeenCalledWith(undefined, 100, config);
    expect(deps.listCodexAppServerModels).toHaveBeenCalledWith(expect.objectContaining({ config }));
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

  it("escapes Codex app-server model ids before chat display", async () => {
    const deps = createDeps({
      listCodexAppServerModels: vi.fn(async () => ({
        models: [
          {
            id: "gpt-5.4 <@U123> [trusted](https://evil)",
            model: "gpt-5.4",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["medium"],
          },
        ],
      })),
    });

    const result = await handleCodexCommand(createContext("models"), { deps });

    expect(result.text).toContain(
      "gpt-5.4 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });

  it("escapes markdown underscores in Codex app-server readouts", async () => {
    const deps = createDeps({
      listCodexAppServerModels: vi.fn(async () => ({
        models: [
          {
            id: "unsafe_model_name",
            model: "unsafe_model_name",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["medium"],
          },
        ],
      })),
    });

    const result = await handleCodexCommand(createContext("models"), { deps });

    expect(result.text).toContain("unsafe\uff3fmodel\uff3fname");
    expect(result.text).not.toContain("unsafe_model_name");
  });

  it("reports status unavailable when every Codex probe fails", async () => {
    const config = { auth: { order: { "openai-codex": ["openai-codex:work"] } } };
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

    await expect(
      handleCodexCommand(createContext("status", undefined, { config }), { deps }),
    ).resolves.toEqual({
      text: [
        "Codex app-server: unavailable",
        "Models: offline",
        "Account: offline",
        "Rate limits: offline",
        "MCP servers: offline",
        "Skills: offline",
      ].join("\n"),
    });
    expect(deps.readCodexStatusProbes).toHaveBeenCalledWith(undefined, config);
  });

  it("escapes Codex status probe errors before chat display", async () => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const offline = { ok: false as const, error: unsafe };
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: offline,
        account: offline,
        limits: offline,
        mcps: offline,
        skills: offline,
      })),
    });

    const result = await handleCodexCommand(createContext("status"), { deps });

    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("escapes successful Codex status model ids and account summaries", async () => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: {
          ok: true as const,
          value: {
            models: [
              {
                id: unsafe,
                model: unsafe,
                inputModalities: ["text"],
                supportedReasoningEfforts: ["medium"],
              },
            ],
          },
        },
        account: {
          ok: true as const,
          value: {
            account: {
              type: "chatgpt" as const,
              email: unsafe,
              planType: "plus" as const,
            },
            requiresOpenaiAuth: false,
          },
        },
        limits: {
          ok: true as const,
          value: {
            rateLimits: {
              limitId: null,
              limitName: null,
              primary: null,
              secondary: null,
              credits: null,
              planType: null,
              rateLimitReachedType: null,
            },
            rateLimitsByLimitId: null,
          },
        },
        mcps: { ok: true as const, value: { data: [], nextCursor: null } },
        skills: { ok: true as const, value: { data: [] } },
      })),
    });

    const result = await handleCodexCommand(createContext("status"), { deps });

    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("summarizes generated Codex rate-limit payloads", async () => {
    const limits = {
      ok: true as const,
      value: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
            secondary: null,
            credits: null,
            planType: null,
            rateLimitReachedType: null,
          },
        },
      },
    };
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: { ok: false as const, error: "offline" },
        account: { ok: false as const, error: "offline" },
        limits,
        mcps: { ok: true as const, value: { data: [], nextCursor: null } },
        skills: { ok: true as const, value: { data: [] } },
      })),
      safeCodexControlRequest: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true as const,
          value: { account: { email: "codex@example.com" } },
        })
        .mockResolvedValueOnce(limits),
    });

    await expect(handleCodexCommand(createContext("status"), { deps })).resolves.toMatchObject({
      text: expect.stringContaining("Rate limits: Codex: primary 42%"),
    });
    await expect(handleCodexCommand(createContext("account"), { deps })).resolves.toMatchObject({
      text: expect.stringContaining("Rate limits: Codex: primary 42%"),
    });
  });

  it("rejects extra operands for read-only Codex commands", async () => {
    const readCodexStatusProbes = vi.fn();
    const listCodexAppServerModels = vi.fn();
    const safeCodexControlRequest = vi.fn();
    const codexControlRequest = vi.fn();
    const getCurrentConversationBinding = vi.fn();
    const deps = createDeps({
      codexControlRequest,
      listCodexAppServerModels,
      readCodexStatusProbes,
      safeCodexControlRequest,
    });

    await expect(handleCodexCommand(createContext("status now"), { deps })).resolves.toEqual({
      text: "Usage: /codex status",
    });
    await expect(handleCodexCommand(createContext("models all"), { deps })).resolves.toEqual({
      text: "Usage: /codex models",
    });
    await expect(handleCodexCommand(createContext("account refresh"), { deps })).resolves.toEqual({
      text: "Usage: /codex account",
    });
    await expect(handleCodexCommand(createContext("mcp list"), { deps })).resolves.toEqual({
      text: "Usage: /codex mcp",
    });
    await expect(handleCodexCommand(createContext("skills list"), { deps })).resolves.toEqual({
      text: "Usage: /codex skills",
    });
    await expect(
      handleCodexCommand(
        createContext("binding current", undefined, {
          getCurrentConversationBinding,
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex binding",
    });

    expect(readCodexStatusProbes).not.toHaveBeenCalled();
    expect(listCodexAppServerModels).not.toHaveBeenCalled();
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(getCurrentConversationBinding).not.toHaveBeenCalled();
  });

  it("formats generated account/read responses", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: { type: "chatgpt", email: "codex@example.com", planType: "pro" },
          requiresOpenaiAuth: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 50, windowDurationMins: 300, resetsAt },
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        },
      });

    const result = await handleCodexCommand(createContext("account"), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain("Account: codex@example.com");
    expect(result.text).toContain("Rate limits: Codex: primary 50%, resets in");
    expect(readRecentCodexRateLimits()).toMatchObject({
      rateLimits: { limitId: "codex" },
    });
    expect(safeCodexControlRequest).toHaveBeenCalledWith(undefined, CODEX_CONTROL_METHODS.account, {
      refreshToken: false,
    });
  });

  it("escapes Codex account probe errors before chat display", async () => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: unsafe })
      .mockResolvedValueOnce({ ok: false as const, error: unsafe });

    const result = await handleCodexCommand(createContext("account"), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("escapes successful Codex account fallback summaries before chat display", async () => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: { account: { id: unsafe } } })
      .mockResolvedValueOnce({ ok: true as const, value: [] });

    const result = await handleCodexCommand(createContext("account"), {
      deps: createDeps({ safeCodexControlRequest }),
    });

    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("@here");
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

  it("rejects malformed compact and review commands before starting thread actions", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const codexControlRequest = vi.fn();

    await expect(
      handleCodexCommand(createContext("compact now", sessionFile), {
        deps: createDeps({ codexControlRequest }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex compact",
    });
    await expect(
      handleCodexCommand(createContext("review staged", sessionFile), {
        deps: createDeps({ codexControlRequest }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex review",
    });
    expect(codexControlRequest).not.toHaveBeenCalled();
  });

  it("escapes started thread-action ids before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-123 <@U123>", cwd: "/repo" }),
    );
    const codexControlRequest = vi.fn(async () => ({}));

    const result = await handleCodexCommand(createContext("compact", sessionFile), {
      deps: createDeps({ codexControlRequest }),
    });

    expect(result.text).toContain("thread-123 &lt;\uff20U123&gt;");
    expect(result.text).not.toContain("<@U123>");
  });

  it("checks Codex Computer Use setup", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => computerUseReadyStatus());

    await expect(
      handleCodexCommand(createContext("computer-use status"), {
        deps: createDeps({ readCodexComputerUseStatus }),
      }),
    ).resolves.toEqual({
      text: [
        "Computer Use: ready",
        "Plugin: computer-use (installed)",
        "MCP server: computer-use (1 tools)",
        "Marketplace: desktop-tools",
        "Tools: list\uff3fapps",
        "Computer Use is ready.",
      ].join("\n"),
    });
    expect(readCodexComputerUseStatus).toHaveBeenCalledWith({
      pluginConfig: undefined,
      forceEnable: false,
    });
  });

  it("escapes Codex Computer Use status fields before chat display", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      pluginName: "<@U123>",
      mcpServerName: "computer-use [server](https://evil)",
      marketplaceName: "desktop_tools",
      tools: ["list_apps", "[click](https://evil)"],
      message: "Computer Use is ready @here.",
    }));

    const result = await handleCodexCommand(createContext("computer-use status"), {
      deps: createDeps({ readCodexComputerUseStatus }),
    });

    expect(result.text).toContain("Plugin: &lt;\uff20U123&gt; (installed)");
    expect(result.text).toContain(
      "MCP server: computer-use \uff3bserver\uff3d\uff08https://evil\uff09 (2 tools)",
    );
    expect(result.text).toContain("Marketplace: desktop\uff3ftools");
    expect(result.text).toContain(
      "Tools: list\uff3fapps, \uff3bclick\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).toContain("Computer Use is ready \uff20here.");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[click](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("formats disabled installed Codex Computer Use plugins", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      ready: false,
      reason: "plugin_disabled" as const,
      pluginEnabled: false,
      mcpServerAvailable: false,
      tools: [],
      message:
        "Computer Use is installed, but the computer-use plugin is disabled. Run /codex computer-use install or enable computerUse.autoInstall to re-enable it.",
    }));

    await expect(
      handleCodexCommand(createContext("computer-use status"), {
        deps: createDeps({ readCodexComputerUseStatus }),
      }),
    ).resolves.toEqual({
      text: expect.stringContaining("Plugin: computer-use (installed, disabled)"),
    });
  });

  it("installs Codex Computer Use from command overrides", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    await expect(
      handleCodexCommand(
        createContext(
          "computer-use install --source github:example/desktop-tools --marketplace desktop-tools",
        ),
        {
          deps: createDeps({ installCodexComputerUse }),
        },
      ),
    ).resolves.toEqual({
      text: expect.stringContaining("Computer Use: ready"),
    });
    expect(installCodexComputerUse).toHaveBeenCalledWith({
      pluginConfig: undefined,
      forceEnable: true,
      overrides: {
        marketplaceSource: "github:example/desktop-tools",
        marketplaceName: "desktop-tools",
      },
    });
  });

  it("shows help when Computer Use option values are missing", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    await expect(
      handleCodexCommand(createContext("computer-use install --source"), {
        deps: createDeps({ installCodexComputerUse }),
      }),
    ).resolves.toEqual({
      text: expect.stringContaining("Usage: /codex computer-use"),
    });
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it("rejects ambiguous Computer Use actions before setup checks", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => computerUseReadyStatus());
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    await expect(
      handleCodexCommand(createContext("computer-use status install"), {
        deps: createDeps({ readCodexComputerUseStatus, installCodexComputerUse }),
      }),
    ).resolves.toEqual({
      text: expect.stringContaining("Usage: /codex computer-use"),
    });
    expect(readCodexComputerUseStatus).not.toHaveBeenCalled();
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it("explains compaction when no Codex thread is attached", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");

    await expect(
      handleCodexCommand(createContext("compact", sessionFile), { deps: createDeps() }),
    ).resolves.toEqual({
      text: "No Codex thread is attached to this OpenClaw session yet.",
    });
  });

  it("asks before sending diagnostics feedback for the attached Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-123", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-123" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics tool loop repro", sessionFile, {
        senderId: "user-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      }),
      { deps },
    );

    const token = readDiagnosticsConfirmationToken(request);
    expect(request.text).toBe(
      [
        "Codex runtime thread detected.",
        "Codex diagnostics can send this thread's feedback bundle to OpenAI servers.",
        "Codex sessions:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "agent:main:session-1",
          sessionId: "session-1",
          threadId: "thread-123",
        }),
        "Note: tool loop repro",
        "Included: Codex logs and spawned Codex subthreads when available.",
        `To send: /codex diagnostics confirm ${token}`,
        `To cancel: /codex diagnostics cancel ${token}`,
        "This request expires in 5 minutes.",
      ].join("\n"),
    );
    expect(request.interactive).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Send diagnostics",
              value: `/codex diagnostics confirm ${token}`,
              style: "danger",
            },
            { label: "Cancel", value: `/codex diagnostics cancel ${token}` },
          ],
        },
      ],
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, {
          senderId: "user-1",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "agent:main:session-1",
          sessionId: "session-1",
          threadId: "thread-123",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      {
        classification: "bug",
        reason: "tool loop repro",
        threadId: "thread-123",
        includeLogs: true,
        tags: {
          source: "openclaw-diagnostics",
          channel: "test",
        },
      },
    );
  });

  it("rejects malformed diagnostics confirmation commands without consuming the token", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-confirm-args", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-confirm-args" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token} extra`, sessionFile), {
        deps,
      }),
    ).resolves.toEqual({
      text: [
        "Usage: /codex diagnostics [note]",
        "Usage: /codex diagnostics confirm <token>",
        "Usage: /codex diagnostics cancel <token>",
      ].join("\n"),
    });
    await expect(
      handleCodexCommand(createContext(`diagnostics cancel ${token} extra`, sessionFile), {
        deps,
      }),
    ).resolves.toEqual({
      text: [
        "Usage: /codex diagnostics [note]",
        "Usage: /codex diagnostics confirm <token>",
        "Usage: /codex diagnostics cancel <token>",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Codex diagnostics sent to OpenAI servers:"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("previews exec-approved diagnostics upload without exposing Codex ids", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-preview", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-preview" },
    }));

    const result = await handleCodexCommand(
      createContext("diagnostics flaky tool call", sessionFile, {
        diagnosticsPreviewOnly: true,
        senderId: "user-1",
        sessionId: "session-preview",
        sessionKey: "agent:main:telegram:preview",
      }),
      { deps: createDeps({ safeCodexControlRequest }) },
    );

    expect(result.text).toBe(
      [
        "Codex runtime thread detected.",
        "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
        "The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
        "Note: flaky tool call",
        "Included: Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    );
    expect(result.text).not.toContain("thread-preview");
    expect(result.text).not.toContain("session-preview");
    expect(result.text).not.toContain("agent:main:telegram:preview");
    expect(result.text).not.toContain("To send:");
    expect(result.interactive).toBeUndefined();
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("sends diagnostics feedback immediately after exec approval", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-approved", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-approved" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    await expect(
      handleCodexCommand(
        createContext("diagnostics approved repro", sessionFile, {
          diagnosticsUploadApproved: true,
          senderId: "user-1",
          sessionId: "session-approved",
          sessionKey: "agent:main:telegram:approved",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "agent:main:telegram:approved",
          sessionId: "session-approved",
          threadId: "thread-approved",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      {
        classification: "bug",
        reason: "approved repro",
        threadId: "thread-approved",
        includeLogs: true,
        tags: {
          source: "openclaw-diagnostics",
          channel: "test",
        },
      },
    );
  });

  it("uploads all Codex diagnostics sessions and reports their channel/thread breakdown", async () => {
    const firstSessionFile = path.join(tempDir, "session-one.jsonl");
    const secondSessionFile = path.join(tempDir, "session-two.jsonl");
    await fs.writeFile(
      `${firstSessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-111", cwd: "/repo" }),
    );
    await fs.writeFile(
      `${secondSessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-222", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async (_config, _method, requestParams) => ({
      ok: true as const,
      value: {
        threadId:
          requestParams && typeof requestParams === "object" && "threadId" in requestParams
            ? requestParams.threadId
            : undefined,
      },
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const diagnosticsSessions = [
      {
        sessionKey: "agent:main:whatsapp:one",
        sessionId: "session-one",
        sessionFile: firstSessionFile,
        channel: "whatsapp",
      },
      {
        sessionKey: "agent:main:discord:two",
        sessionId: "session-two",
        sessionFile: secondSessionFile,
        channel: "discord",
      },
    ];

    const request = await handleCodexCommand(
      createContext("diagnostics multi-session repro", firstSessionFile, {
        senderId: "user-1",
        channel: "whatsapp",
        sessionKey: "agent:main:whatsapp:one",
        sessionId: "session-one",
        diagnosticsSessions,
      }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);
    expect(request.text).toContain("Codex runtime threads detected.");
    expect(request.text).toContain("OpenClaw session key: `agent:main:whatsapp:one`");
    expect(request.text).toContain("OpenClaw session id: `session-one`");
    expect(request.text).toContain("Codex thread id: `thread-111`");
    expect(request.text).toContain("OpenClaw session key: `agent:main:discord:two`");
    expect(request.text).toContain("OpenClaw session id: `session-two`");
    expect(request.text).toContain("Codex thread id: `thread-222`");
    expect(safeCodexControlRequest).not.toHaveBeenCalled();

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, firstSessionFile, {
          senderId: "user-1",
          channel: "whatsapp",
          sessionKey: "agent:main:whatsapp:one",
          sessionId: "session-one",
          diagnosticsSessions,
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          index: 1,
          channel: "whatsapp",
          sessionKey: "agent:main:whatsapp:one",
          sessionId: "session-one",
          threadId: "thread-111",
        }),
        "",
        ...expectedDiagnosticsTargetBlock({
          index: 2,
          channel: "discord",
          sessionKey: "agent:main:discord:two",
          sessionId: "session-two",
          threadId: "thread-222",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      1,
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      expect.objectContaining({ threadId: "thread-111", includeLogs: true }),
    );
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      2,
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      expect.objectContaining({ threadId: "thread-222", includeLogs: true }),
    );
  });

  it("requires an owner for Codex diagnostics feedback uploads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-owner", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-owner" },
    }));

    await expect(
      handleCodexCommand(
        createContext("diagnostics", sessionFile, {
          senderIsOwner: false,
        }),
        { deps: createDeps({ safeCodexControlRequest }) },
      ),
    ).resolves.toEqual({
      text: "Only an owner can send Codex diagnostics.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("refuses diagnostics confirmations without a stable sender identity", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-sender-required", cwd: "/repo" }),
    );

    await expect(
      handleCodexCommand(
        createContext("diagnostics", sessionFile, {
          senderId: undefined,
        }),
        { deps: createDeps() },
      ),
    ).resolves.toEqual({
      text: "Cannot send Codex diagnostics because this command did not include a sender identity.",
    });
  });

  it("keeps diagnostics confirmation scoped to the requesting sender", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-sender", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-sender" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics", sessionFile, { senderId: "user-1" }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, { senderId: "user-2" }),
        { deps },
      ),
    ).resolves.toEqual({
      text: "Only the user who requested these Codex diagnostics can confirm the upload.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("consumes diagnostics confirmations before async upload work", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    let releaseFirstConfirmBindingRead: () => void = () => undefined;
    let firstConfirmBindingReadStarted: () => void = () => undefined;
    const firstConfirmBindingRead = new Promise<void>((resolve) => {
      releaseFirstConfirmBindingRead = resolve;
    });
    const firstConfirmBindingReadStartedPromise = new Promise<void>((resolve) => {
      firstConfirmBindingReadStarted = resolve;
    });
    let bindingReadCount = 0;
    const readCodexAppServerBinding = vi.fn(async (bindingSessionFile: string) => {
      bindingReadCount += 1;
      if (bindingReadCount === 2) {
        firstConfirmBindingReadStarted();
        await firstConfirmBindingRead;
      }
      return {
        schemaVersion: 1 as const,
        threadId: "thread-race",
        cwd: "/repo",
        sessionFile: bindingSessionFile,
        createdAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
      };
    });
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-race" },
    }));
    const deps = createDeps({ readCodexAppServerBinding, safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics", sessionFile, { senderId: "user-1" }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);
    const firstConfirm = handleCodexCommand(
      createContext(`diagnostics confirm ${token}`, sessionFile, { senderId: "user-1" }),
      { deps },
    );
    await firstConfirmBindingReadStartedPromise;

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, { senderId: "user-1" }),
        { deps },
      ),
    ).resolves.toEqual({
      text: "No pending Codex diagnostics confirmation was found. Run /diagnostics again to create a fresh request.",
    });

    releaseFirstConfirmBindingRead();
    await expect(firstConfirm).resolves.toMatchObject({
      text: expect.stringContaining("Codex diagnostics sent to OpenAI servers:"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics confirmation scoped to account and channel identity", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-account", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-account" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics", sessionFile, {
        accountId: "account-1",
        channelId: "channel-1",
        messageThreadId: "thread-1",
        threadParentId: "parent-1",
        sessionKey: "session-key-1",
      }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, {
          accountId: "account-2",
          channelId: "channel-1",
          messageThreadId: "thread-1",
          threadParentId: "parent-1",
          sessionKey: "session-key-1",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: "This Codex diagnostics confirmation belongs to a different account.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("allows private-routed diagnostics confirmations from the owner DM", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-private", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-private" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics", sessionFile, {
        accountId: "account-1",
        channelId: "group-channel",
        messageThreadId: "group-topic",
        sessionKey: "group-session",
        diagnosticsPrivateRouted: true,
      }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, undefined, {
          accountId: "account-1",
          channelId: "owner-dm",
          sessionKey: "owner-dm-session",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "group-session",
          threadId: "thread-private",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      expect.objectContaining({
        classification: "bug",
        threadId: "thread-private",
        includeLogs: true,
      }),
    );
  });

  it("keeps diagnostics confirmation eviction scoped to account identity", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-confirm-scope", cwd: "/repo" }),
    );

    const firstRequest = await handleCodexCommand(
      createContext("diagnostics", sessionFile, {
        accountId: "account-kept",
        channelId: "channel-kept",
      }),
      { deps: createDeps() },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);

    for (let index = 0; index < 100; index += 1) {
      await handleCodexCommand(
        createContext(`diagnostics ${index}`, sessionFile, {
          accountId: "account-noisy",
          channelId: "channel-noisy",
        }),
        { deps: createDeps() },
      );
    }

    await expect(
      handleCodexCommand(
        createContext(`diagnostics cancel ${firstToken}`, sessionFile, {
          accountId: "account-kept",
          channelId: "channel-kept",
        }),
        { deps: createDeps() },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics upload canceled.",
        "Codex sessions:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          threadId: "thread-confirm-scope",
        }),
      ].join("\n"),
    });
  });

  it("bounds diagnostics notes before upload", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-789", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-789" },
    }));
    const note = "x".repeat(2050);
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext(`diagnostics ${note}`, sessionFile), {
      deps,
    });
    const token = readDiagnosticsConfirmationToken(request);
    await handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps });

    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      expect.objectContaining({
        reason: "x".repeat(2048),
      }),
    );
  });

  it("escapes diagnostics notes before showing approval text", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-note", cwd: "/repo" }),
    );

    const request = await handleCodexCommand(
      createContext("diagnostics <@U123> [trusted](https://evil) @here `tick`", sessionFile),
      { deps: createDeps() },
    );

    expect(request.text).toContain(
      "Note: &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here \uff40tick\uff40",
    );
    expect(request.text).not.toContain("<@U123>");
    expect(request.text).not.toContain("[trusted](https://evil)");
  });

  it("throttles repeated diagnostics uploads for the same thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-cooldown", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-cooldown" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics first", sessionFile), {
      deps,
    });
    const token = readDiagnosticsConfirmationToken(request);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          threadId: "thread-cooldown",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    await expect(
      handleCodexCommand(createContext("diagnostics again", sessionFile), { deps }),
    ).resolves.toEqual({
      text: "Codex diagnostics were already sent for thread thread-cooldown recently. Try again in 60s.",
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("throttles diagnostics uploads across threads", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const sessionFile = path.join(tempDir, "global-cooldown-session.jsonl");

    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-global-1", cwd: "/repo" }),
    );
    const request = await handleCodexCommand(createContext("diagnostics first", sessionFile), {
      deps,
    });
    const token = readDiagnosticsConfirmationToken(request);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          threadId: "thread-global-1",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });

    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-global-2", cwd: "/repo" }),
    );
    await expect(
      handleCodexCommand(createContext("diagnostics second", sessionFile), { deps }),
    ).resolves.toEqual({
      text: "Codex diagnostics were already sent for this account or channel recently. Try again in 60s.",
    });

    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("does not throttle diagnostics uploads across different account scopes", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const sessionFile = path.join(tempDir, "scoped-cooldown-session.jsonl");

    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-scope-1", cwd: "/repo" }),
    );
    const firstRequest = await handleCodexCommand(
      createContext("diagnostics first", sessionFile, {
        accountId: "account-1",
        channelId: "channel-1",
      }),
      { deps },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);
    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${firstToken}`, sessionFile, {
          accountId: "account-1",
          channelId: "channel-1",
        }),
        { deps },
      ),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Codex diagnostics sent to OpenAI servers:"),
    });

    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-scope-2", cwd: "/repo" }),
    );
    const secondRequest = await handleCodexCommand(
      createContext("diagnostics second", sessionFile, {
        accountId: "account-2",
        channelId: "channel-2",
      }),
      { deps },
    );
    const secondToken = readDiagnosticsConfirmationToken(secondRequest);
    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${secondToken}`, sessionFile, {
          accountId: "account-2",
          channelId: "channel-2",
        }),
        { deps },
      ),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Codex diagnostics sent to OpenAI servers:"),
    });

    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("does not collide diagnostics cooldown scopes when ids contain delimiters", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const sessionFile = path.join(tempDir, "delimiter-cooldown-session.jsonl");

    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-delimiter-1", cwd: "/repo" }),
    );
    const firstScope = {
      accountId: "a",
      channelId: "b",
      channel: "test|channel:x",
    };
    const firstRequest = await handleCodexCommand(
      createContext("diagnostics first", sessionFile, firstScope),
      { deps },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);
    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${firstToken}`, sessionFile, firstScope),
        { deps },
      ),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Codex diagnostics sent to OpenAI servers:"),
    });

    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-delimiter-2", cwd: "/repo" }),
    );
    const secondScope = {
      accountId: "a|channelId:b",
      channel: "test|channel:x",
    };
    const secondRequest = await handleCodexCommand(
      createContext("diagnostics second", sessionFile, secondScope),
      { deps },
    );
    const secondToken = readDiagnosticsConfirmationToken(secondRequest);
    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${secondToken}`, sessionFile, secondScope),
        { deps },
      ),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Codex diagnostics sent to OpenAI servers:"),
    });

    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("does not collide diagnostics cooldown scopes when long ids share a prefix", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const sessionFile = path.join(tempDir, "long-scope-cooldown-session.jsonl");
    const sharedPrefix = "account-".repeat(40);

    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-long-scope-1", cwd: "/repo" }),
    );
    const firstScope = {
      accountId: `${sharedPrefix}first`,
      channelId: "channel-long",
    };
    const firstRequest = await handleCodexCommand(
      createContext("diagnostics first", sessionFile, firstScope),
      { deps },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);
    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${firstToken}`, sessionFile, firstScope),
        { deps },
      ),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Codex diagnostics sent to OpenAI servers:"),
    });

    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-long-scope-2", cwd: "/repo" }),
    );
    const secondScope = {
      accountId: `${sharedPrefix}second`,
      channelId: "channel-long",
    };
    const secondRequest = await handleCodexCommand(
      createContext("diagnostics second", sessionFile, secondScope),
      { deps },
    );
    const secondToken = readDiagnosticsConfirmationToken(secondRequest);
    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${secondToken}`, sessionFile, secondScope),
        { deps },
      ),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Codex diagnostics sent to OpenAI servers:"),
    });

    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("sanitizes diagnostics upload errors before showing them", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "<@U123>", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: false as const,
      error: "bad\n\u009b\u202e <@U123> [trusted](https://evil) @here",
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    expect(request.text).toContain("Codex thread id: &lt;\uff20U123&gt;");
    expect(request.text).not.toContain("<@U123>");
    const token = readDiagnosticsConfirmationToken(request);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Could not send Codex diagnostics:",
        "- channel test, Codex thread &lt;\uff20U123&gt;: bad??? &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
        "Inspect locally:",
        "- run codex resume and paste the thread id shown above",
      ].join("\n"),
    });
  });

  it("does not throttle diagnostics retries after upload failures", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-retry", cwd: "/repo" }),
    );
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "temporary outage" })
      .mockResolvedValueOnce({ ok: true as const, value: { threadId: "thread-retry" } });
    const deps = createDeps({ safeCodexControlRequest });

    const firstRequest = await handleCodexCommand(createContext("diagnostics", sessionFile), {
      deps,
    });
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${firstToken}`, sessionFile), {
        deps,
      }),
    ).resolves.toEqual({
      text: [
        "Could not send Codex diagnostics:",
        "- channel test, Codex thread thread-retry: temporary outage",
        "Inspect locally:",
        "- `codex resume thread-retry`",
      ].join("\n"),
    });

    const secondRequest = await handleCodexCommand(createContext("diagnostics", sessionFile), {
      deps,
    });
    const secondToken = readDiagnosticsConfirmationToken(secondRequest);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${secondToken}`, sessionFile), {
        deps,
      }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          threadId: "thread-retry",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("omits inline diagnostics resume commands for unsafe thread ids", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123'`\n\u009b\u202e; echo bad",
        cwd: "/repo",
      }),
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-123'`\n\u009b\u202e; echo bad" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    const token = readDiagnosticsConfirmationToken(request);
    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        "Session 1",
        "Channel: test",
        "Codex thread id: thread-123'\uff40???; echo bad",
        "Inspect locally: run codex resume and paste the thread id shown above",
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
  });

  it("explains diagnostics when no Codex thread is attached", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");

    await expect(
      handleCodexCommand(createContext("diagnostics", sessionFile), { deps: createDeps() }),
    ).resolves.toEqual({
      text: [
        "No Codex thread is attached to this OpenClaw session yet.",
        "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
      ].join("\n"),
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

  it("escapes Codex thread fields and avoids unsafe resume commands", async () => {
    const codexControlRequest = vi.fn(async () => ({
      data: [
        {
          id: "thread-123\n`bad`",
          title: "<@U123> [trusted](https://evil) @here",
          model: "gpt_5",
          cwd: "/repo_(x)",
        },
      ],
    }));
    const deps = createDeps({ codexControlRequest });

    const result = await handleCodexCommand(createContext("threads"), { deps });

    expect(result.text).toContain("thread-123?\uff40bad\uff40");
    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).toContain("(gpt\uff3f5, /repo\uff3f\uff08x\uff09)");
    expect(result.text).toContain(
      "Resume: copy the thread id above and run /codex resume <thread-id>",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("Resume: /codex resume thread-123");
  });

  it("escapes Codex MCP and skill list entries before chat display", async () => {
    const codexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ name: "<@U123> [mcp](https://evil)" }] })
      .mockResolvedValueOnce({ data: [{ id: "skill_1 @here" }] });
    const deps = createDeps({ codexControlRequest });

    const mcp = await handleCodexCommand(createContext("mcp"), { deps });
    const skills = await handleCodexCommand(createContext("skills"), { deps });

    expect(mcp.text).toContain("&lt;\uff20U123&gt; \uff3bmcp\uff3d\uff08https://evil\uff09");
    expect(skills.text).toContain("skill\uff3f1 \uff20here");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("<@U123>");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("[mcp](https://evil)");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("@here");
  });

  it("returns sanitized command failures instead of leaking app-server errors", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-123", cwd: "/repo" }),
    );
    const failure = () => {
      throw new Error("app-server failed <@U123> [trusted](https://evil) @here");
    };
    const expectSanitizedFailure = (result: PluginCommandResult) => {
      expect(result.text).toContain(
        "Codex command failed: app-server failed &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
      );
      expect(result.text).not.toContain("<@U123>");
      expect(result.text).not.toContain("[trusted](https://evil)");
      expect(result.text).not.toContain("@here");
    };

    for (const [args, deps] of [
      ["models", createDeps({ listCodexAppServerModels: vi.fn(failure) })],
      ["threads", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["mcp", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["skills", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["resume thread-123", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["compact", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["review", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["bind", createDeps({ startCodexConversationThread: vi.fn(failure) })],
      ["stop", createDeps({ stopCodexConversationTurn: vi.fn(failure) })],
      ["steer keep going", createDeps({ steerCodexConversationTurn: vi.fn(failure) })],
      ["model gpt-5.4", createDeps({ setCodexConversationModel: vi.fn(failure) })],
    ] as const) {
      expectSanitizedFailure(await handleCodexCommand(createContext(args, sessionFile), { deps }));
    }
  });

  it("binds the current conversation to a Codex app-server thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123",
        cwd: "/repo",
        authProfileId: "openai-codex:work",
        modelProvider: "openai",
      }),
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
      config: {},
      sessionFile,
      workspaceDir: "/repo",
      threadId: "thread-123",
      model: "gpt-5.4",
      modelProvider: "openai",
      authProfileId: "openai-codex:work",
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

  it("binds quoted workspace paths that contain spaces", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const startCodexConversationThread = vi.fn(async () => ({
      kind: "codex-app-server-session" as const,
      version: 1 as const,
      sessionFile,
      workspaceDir: "/repo with space",
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
        createContext('bind thread-123 --cwd "/repo with space"', sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            startCodexConversationThread,
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Bound this conversation to Codex thread thread-123 in /repo with space.",
    });
    expect(startCodexConversationThread).toHaveBeenCalledWith({
      pluginConfig: undefined,
      config: {},
      sessionFile,
      workspaceDir: "/repo with space",
      threadId: "thread-123",
      model: undefined,
      modelProvider: undefined,
    });
  });

  it("escapes bound Codex thread ids and workspace paths before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const unsafeThread = "thread-123 <@U123>";
    const unsafeWorkspace = "/repo [trusted](https://evil)";
    const startCodexConversationThread = vi.fn(async () => ({
      kind: "codex-app-server-session" as const,
      version: 1 as const,
      sessionFile,
      workspaceDir: unsafeWorkspace,
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

    const result = await handleCodexCommand(
      createContext(`bind "${unsafeThread}" --cwd "${unsafeWorkspace}"`, sessionFile, {
        requestConversationBinding,
      }),
      {
        deps: createDeps({
          startCodexConversationThread,
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        }),
      },
    );

    expect(result.text).toContain("thread-123 &lt;\uff20U123&gt;");
    expect(result.text).toContain("/repo \uff3btrusted\uff3d\uff08https://evil\uff09");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary:
          "Codex app-server thread thread-123 &lt;\uff20U123&gt; in /repo \uff3btrusted\uff3d\uff08https://evil\uff09",
      }),
    );
  });

  it("rejects bind options with missing, blank, or repeated values before starting Codex", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const startCodexConversationThread = vi.fn();
    const requestConversationBinding = vi.fn();

    await expect(
      handleCodexCommand(
        createContext("bind thread-123 --cwd --model gpt-5.4", sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            startCodexConversationThread,
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    await expect(
      handleCodexCommand(
        createContext('bind thread-123 --cwd ""', sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            startCodexConversationThread,
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    await expect(
      handleCodexCommand(
        createContext("bind thread-123 --cwd /repo --cwd /other", sessionFile, {
          requestConversationBinding,
        }),
        {
          deps: createDeps({
            startCodexConversationThread,
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          }),
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    expect(startCodexConversationThread).not.toHaveBeenCalled();
    expect(requestConversationBinding).not.toHaveBeenCalled();
  });

  it("rejects malformed bind arguments before requiring a session file", async () => {
    const startCodexConversationThread = vi.fn();

    await expect(
      handleCodexCommand(createContext("bind thread-123 --cwd", undefined), {
        deps: createDeps({
          startCodexConversationThread,
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        }),
      }),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    expect(startCodexConversationThread).not.toHaveBeenCalled();
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
            message: "binding unsupported <@U123> [trusted](https://evil)",
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
    ).resolves.toEqual({
      text: "binding unsupported &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
    });
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

  it("rejects malformed detach commands before clearing bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const clearCodexAppServerBinding = vi.fn();
    const detachConversationBinding = vi.fn();

    await expect(
      handleCodexCommand(
        createContext("detach now", sessionFile, {
          detachConversationBinding,
        }),
        { deps: createDeps({ clearCodexAppServerBinding }) },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex detach",
    });
    expect(detachConversationBinding).not.toHaveBeenCalled();
    expect(clearCodexAppServerBinding).not.toHaveBeenCalled();
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

  it("rejects malformed stop commands before interrupting Codex", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const stopCodexConversationTurn = vi.fn();

    await expect(
      handleCodexCommand(createContext("stop now", sessionFile), {
        deps: createDeps({ stopCodexConversationTurn }),
      }),
    ).resolves.toEqual({ text: "Usage: /codex stop" });
    expect(stopCodexConversationTurn).not.toHaveBeenCalled();
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

  it("escapes current bound model status before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-model",
        cwd: "/repo",
        model: "model_<@U123>_[trusted](https://evil)",
      }),
    );

    const result = await handleCodexCommand(createContext("model", sessionFile), {
      deps: createDeps(),
    });

    expect(result.text).toContain(
      "model\uff3f&lt;\uff20U123&gt;\uff3f\uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });

  it("rejects malformed model commands before persisting the model", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const setCodexConversationModel = vi.fn();

    await expect(
      handleCodexCommand(createContext("model gpt-5.4 extra", sessionFile), {
        deps: createDeps({ setCodexConversationModel }),
      }),
    ).resolves.toEqual({ text: "Usage: /codex model <model>" });
    expect(setCodexConversationModel).not.toHaveBeenCalled();
  });

  it("rejects extra fast and permissions arguments", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const setCodexConversationFastMode = vi.fn();
    const setCodexConversationPermissions = vi.fn();
    const deps = createDeps({
      setCodexConversationFastMode,
      setCodexConversationPermissions,
    });

    await expect(
      handleCodexCommand(createContext("fast on now", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Usage: /codex fast [on|off|status]" });
    await expect(
      handleCodexCommand(createContext("permissions yolo now", sessionFile), { deps }),
    ).resolves.toEqual({ text: "Usage: /codex permissions [default|yolo|status]" });

    expect(setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(setCodexConversationPermissions).not.toHaveBeenCalled();
  });

  it("rejects malformed control arguments before requiring a session file", async () => {
    const deps = createDeps({
      setCodexConversationModel: vi.fn(),
      setCodexConversationFastMode: vi.fn(),
      setCodexConversationPermissions: vi.fn(),
    });

    await expect(
      handleCodexCommand(createContext("model gpt-5.4 extra"), { deps }),
    ).resolves.toEqual({
      text: "Usage: /codex model <model>",
    });
    await expect(handleCodexCommand(createContext("fast on now"), { deps })).resolves.toEqual({
      text: "Usage: /codex fast [on|off|status]",
    });
    await expect(
      handleCodexCommand(createContext("permissions yolo now"), { deps }),
    ).resolves.toEqual({
      text: "Usage: /codex permissions [default|yolo|status]",
    });
    expect(deps.setCodexConversationModel).not.toHaveBeenCalled();
    expect(deps.setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(deps.setCodexConversationPermissions).not.toHaveBeenCalled();
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
        `- Session: ${sessionFile.replaceAll("_", "\uff3f")}`,
      ].join("\n"),
    });
  });

  it("escapes active binding fields before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123 <@U123>",
        cwd: "/repo",
        model: "gpt [trusted](https://evil)",
      }),
    );

    const result = await handleCodexCommand(
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
            workspaceDir: "/repo <@U123>",
          },
        }),
      }),
      { deps: createDeps() },
    );

    expect(result.text).toContain("Thread: thread-123 &lt;\uff20U123&gt;");
    expect(result.text).toContain("Workspace: /repo &lt;\uff20U123&gt;");
    expect(result.text).toContain("Model: gpt \uff3btrusted\uff3d\uff08https://evil\uff09");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });
});

function computerUseReadyStatus(): CodexComputerUseStatus {
  return {
    enabled: true,
    ready: true,
    reason: "ready",
    installed: true,
    pluginEnabled: true,
    mcpServerAvailable: true,
    pluginName: "computer-use",
    mcpServerName: "computer-use",
    marketplaceName: "desktop-tools",
    tools: ["list_apps"],
    message: "Computer Use is ready.",
  };
}
