import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  executorTestMocks,
  expectRecordFields,
  expectSendMessageCall,
  registerAndResolveCommandHandler,
  resetSessionMetaMocks,
} from "./bot-native-command-executors.test-support.js";
import { createTelegramPrivateCommandContext } from "./bot-native-commands.fixture-test-support.js";

const { agentRuntimeMocks, commandAuthMocks, replyMocks, sessionMocks } = executorTestMocks;

describe("Telegram native command built-ins", () => {
  beforeEach(resetSessionMetaMocks);

  it("uses the target session model when building native argument menus", async () => {
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "anthropic/claude-opus-4-7": {
              params: { thinking: "xhigh" },
            },
          },
        },
      },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({
      "agent:main:main": {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "user",
        thinkingLevel: "high",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "think" && params.provider === "anthropic",
    )?.[0];
    expectRecordFields(
      menuCall,
      { provider: "anthropic", model: "claude-opus-4-7" },
      "thinking menu call",
    );
    expect(sessionMocks.getSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-sessions.json",
      sessionKey: "agent:main:main",
    });
    expectSendMessageCall({
      sendMessage,
      chatId: 100,
      textIncludes: "Current thinking level: high.\nChoose level for /think.",
      requireReplyMarkup: true,
      label: "thinking menu",
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it.each([
    { sessionRuntime: undefined, expectedRuntime: "codex" },
    { sessionRuntime: "openclaw", expectedRuntime: "openclaw" },
  ])(
    "uses the effective $expectedRuntime runtime for native /think menus",
    async ({ sessionRuntime, expectedRuntime }) => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
            },
          },
        },
      } as OpenClawConfig;
      sessionMocks.sessionStoreEntries.mockReturnValue({
        "agent:main:main": {
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
          modelOverrideSource: "user",
          ...(sessionRuntime ? { agentRuntimeOverride: sessionRuntime } : {}),
          updatedAt: 0,
        },
      });

      const { handler } = registerAndResolveCommandHandler({
        commandName: "think",
        cfg,
        allowFrom: ["*"],
      });
      await handler(createTelegramPrivateCommandContext());

      const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
        ([params]) => params.command.key === "think" && params.model === "gpt-5.6-luna",
      )?.[0];
      expectRecordFields(
        menuCall,
        {
          provider: "openai",
          model: "gpt-5.6-luna",
          agentRuntime: expectedRuntime,
        },
        "runtime-aware thinking menu call",
      );
    },
  );

  it("resolves /think menu choices against the runtime catalog for live-discovered models", async () => {
    const cfg = {
      agents: { defaults: { models: { "ollama/*": {} } } },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({
      "agent:main:main": {
        providerOverride: "ollama",
        modelOverride: "glm-5.2:cloud",
        modelOverrideSource: "user",
        updatedAt: 0,
      },
    });
    const runtimeCatalog = [
      { provider: "ollama", id: "glm-5.2:cloud", name: "glm-5.2:cloud", reasoning: true },
    ];
    agentRuntimeMocks.loadModelCatalog.mockClear().mockResolvedValue(runtimeCatalog);

    const { handler } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "think" && params.provider === "ollama",
    )?.[0];
    const menuRecord = expectRecordFields(
      menuCall,
      { provider: "ollama", model: "glm-5.2:cloud" },
      "ollama thinking menu call",
    );
    expect(agentRuntimeMocks.loadModelCatalog).toHaveBeenCalled();
    expect(menuRecord.catalog).toEqual(runtimeCatalog);
  });

  it("loads the runtime catalog for /think when no session model override is set", async () => {
    const cfg = {
      agents: { defaults: { model: "ollama/glm-5.2:cloud", models: { "ollama/*": {} } } },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({});
    const runtimeCatalog = [
      { provider: "ollama", id: "glm-5.2:cloud", name: "glm-5.2:cloud", reasoning: true },
    ];
    agentRuntimeMocks.loadModelCatalog.mockClear().mockResolvedValue(runtimeCatalog);

    const { handler } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    expect(agentRuntimeMocks.loadModelCatalog).toHaveBeenCalled();
    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "think",
    )?.[0];
    const menuRecord = expectRecordFields(menuCall, {}, "default-model thinking menu call");
    expect(menuRecord.provider).toBeUndefined();
    expect(menuRecord.catalog).toEqual(runtimeCatalog);
  });

  it("inherits the parent session model when building DM thread native argument menus", async () => {
    const cfg: OpenClawConfig = {};
    sessionMocks.sessionStoreEntries.mockReturnValue({
      "agent:main:main": {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "user",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext({ threadId: 77 }));

    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "think" && params.provider === "anthropic",
    )?.[0];
    expectRecordFields(
      menuCall,
      { provider: "anthropic", model: "claude-opus-4-7" },
      "thread thinking menu call",
    );
    expectSendMessageCall({
      sendMessage,
      chatId: 100,
      textIncludes: "Choose level for /think.",
      requireReplyMarkup: true,
      label: "thread thinking menu",
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses the configured default model instead of temporary auto fallback overrides", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          thinkingDefault: "medium",
        },
      },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({
      "agent:main:main": {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "auto",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "think" && params.provider === "openai",
    )?.[0];
    expectRecordFields(
      menuCall,
      { provider: "openai", model: "gpt-5.5" },
      "default model thinking menu call",
    );
    expectSendMessageCall({
      sendMessage,
      chatId: 100,
      textIncludes: "Current thinking level: medium.\nChoose level for /think.",
      requireReplyMarkup: true,
      label: "default model thinking menu",
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses configured model defaults instead of runtime auth metadata for the fast menu", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": {
              params: { fastMode: "auto", fastAutoOnSeconds: 30 },
            },
          },
        },
      },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({
      "agent:main:main": {
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "fast",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    const menuCall = commandAuthMocks.resolveCommandArgMenu.mock.calls.find(
      ([params]) => params.command.key === "fast",
    )?.[0];
    expectRecordFields(menuCall, { cfg }, "fast menu call");
    expect(
      commandAuthMocks.resolveCommandArgMenu.mock.calls.some(
        ([params]) =>
          params.command.key === "fast" &&
          params.provider === "openai" &&
          params.model === "gpt-5.5",
      ),
    ).toBe(true);
    const options = expectSendMessageCall({
      sendMessage,
      chatId: 100,
      textIncludes:
        "Current fast mode: auto (30 sec) (default: model).\nOptions: on, off, auto (30 sec), default, status.",
      requireReplyMarkup: true,
      label: "fast menu",
    });
    const replyMarkup = options.reply_markup as
      | { inline_keyboard?: Array<Array<{ text?: string }>> }
      | undefined;
    const labels = (replyMarkup?.inline_keyboard ?? []).flatMap((row) =>
      row.map((button) => button.text),
    );
    expect(labels).toContain("auto (30 sec)");
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses the read-only catalog for Claude CLI thinking menus", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-8" },
        },
      },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({});
    agentRuntimeMocks.loadModelCatalog.mockImplementation(async (params) => {
      if (!params?.readOnly) {
        throw new Error("native /think must not start full model discovery");
      }
      return [
        {
          provider: "anthropic",
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          reasoning: true,
        },
      ];
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    expect(agentRuntimeMocks.loadModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        agentDir: expect.any(String),
        readOnly: true,
      }),
    );
    expect(agentRuntimeMocks.loadModelCatalog.mock.calls[0]?.[0]).not.toHaveProperty(
      "workspaceDir",
    );
    expectSendMessageCall({
      sendMessage,
      chatId: 100,
      textIncludes: "Current thinking level: off.\nChoose level for /think.",
      requireReplyMarkup: true,
      label: "Claude CLI thinking menu",
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("uses target model thinking defaults before global thinking defaults", async () => {
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "anthropic/claude-opus-4-7": {
              params: { thinking: "xhigh" },
            },
          },
        },
      },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({
      "agent:main:main": {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "user",
        updatedAt: 0,
      },
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    expectSendMessageCall({
      sendMessage,
      chatId: 100,
      textIncludes: "Current thinking level: xhigh.\nChoose level for /think.",
      requireReplyMarkup: true,
      label: "target model thinking menu",
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("does not activate nested agent-model thinking params", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "anthropic/claude-opus-4-7": { params: { thinking: "low" } },
          },
        },
        entries: {
          main: {
            models: {
              "anthropic/claude-opus-4-7": { params: { thinking: "high" } },
            },
          },
        },
      },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({});

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    expectSendMessageCall({
      sendMessage,
      chatId: 100,
      textIncludes: "Current thinking level: low.\nChoose level for /think.",
      requireReplyMarkup: true,
      label: "default-model thinking menu",
    });
  });

  it("uses per-agent thinking defaults before target model and global thinking defaults", async () => {
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "anthropic/claude-opus-4-7": {
              params: { thinking: "xhigh" },
            },
          },
        },
        list: [
          {
            id: "alpha",
            model: { primary: "anthropic/claude-opus-4-7" },
            thinkingDefault: "minimal",
          },
        ],
      },
    } as OpenClawConfig;
    sessionMocks.sessionStoreEntries.mockReturnValue({});

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg,
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext());

    expectSendMessageCall({
      sendMessage,
      chatId: 100,
      textIncludes: "Current thinking level: minimal.\nChoose level for /think.",
      requireReplyMarkup: true,
      label: "agent thinking menu",
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("does not load the session store when a native argument menu is skipped", async () => {
    const { handler } = registerAndResolveCommandHandler({
      commandName: "think",
      cfg: {},
      allowFrom: ["*"],
    });
    await handler(createTelegramPrivateCommandContext({ match: "high" }));

    expect(sessionMocks.sessionStoreEntries).not.toHaveBeenCalled();
    expect(agentRuntimeMocks.loadModelCatalog).not.toHaveBeenCalled();
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });
});
