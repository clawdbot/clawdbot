import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
  editMessageTelegram,
  emitTelegramMessageSentHooks,
  listSkillCommandsForAgents,
  resetNativeCommandMenuMocks,
  waitForRegisteredCommands,
} from "./bot-native-commands.menu-test-support.js";
import { resetTelegramForumFlagCacheForTest } from "./bot/helpers.js";
import { TELEGRAM_COMMAND_NAME_PATTERN } from "./command-config.js";
import { pluginCommandMocks, resetPluginCommandMocks } from "./test-support/plugin-command.js";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;
let parseTelegramNativeCommandCallbackData: typeof import("./bot-native-commands.js").parseTelegramNativeCommandCallbackData;
let resolveTelegramNativeCommandDisableBlockStreaming: typeof import("./bot-native-commands.js").resolveTelegramNativeCommandDisableBlockStreaming;

type CommandBotHarness = ReturnType<typeof createCommandBot>;
type TelegramInlineKeyboardReplyMarkup = {
  inline_keyboard?: Array<Array<{ callback_data?: string }>>;
};
type PlugCommandHarnessParams = {
  botHarness?: CommandBotHarness;
  cfg?: OpenClawConfig;
  command?: Record<string, unknown>;
  args?: string;
  result?: Record<string, unknown>;
  registerOverrides?: Partial<Parameters<typeof registerTelegramNativeCommands>[0]>;
};

function primePlugCommand(params: PlugCommandHarnessParams = {}) {
  pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
    {
      name: "plug",
      description: "Plugin command",
    },
  ] as never);
  pluginCommandMocks.matchPluginCommand.mockReturnValue({
    command: {
      key: "plug",
      requireAuth: false,
      ...params.command,
    },
    args: params.args,
  } as never);
  pluginCommandMocks.executePluginCommand.mockResolvedValue(
    (params.result ?? { text: "ok" }) as never,
  );
}

function registerPlugCommand(params: PlugCommandHarnessParams = {}) {
  const botHarness = params.botHarness ?? createCommandBot();
  primePlugCommand(params);
  registerTelegramNativeCommands({
    ...createNativeCommandTestParams(params.cfg ?? {}, {
      bot: botHarness.bot,
      ...params.registerOverrides,
    }),
  });
  const handler = botHarness.commandHandlers.get("plug");
  if (!handler) {
    throw new Error("expected plug command handler to be registered");
  }
  return {
    ...botHarness,
    handler,
  };
}

function collectCallbackData(replyMarkup: TelegramInlineKeyboardReplyMarkup | undefined): string[] {
  const callbackData: string[] = [];
  for (const row of replyMarkup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (button.callback_data) {
        callbackData.push(button.callback_data);
      }
    }
  }
  return callbackData;
}

function firstCall(mock: { mock: { calls: Array<Array<unknown>> } }) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected first mock call");
  }
  return call;
}

function firstCallArg(mock: { mock: { calls: Array<Array<unknown>> } }, argIndex = 0) {
  const arg = firstCall(mock)[argIndex];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected first mock call arg ${argIndex}`);
  }
  return arg as Record<string, unknown>;
}

function firstDeliverRepliesParams() {
  return firstCallArg(deliverReplies as unknown as { mock: { calls: Array<Array<unknown>> } });
}

function firstExecutePluginCommandParams() {
  return firstCallArg(
    pluginCommandMocks.executePluginCommand as unknown as {
      mock: { calls: Array<Array<unknown>> };
    },
  );
}

function replyAt(params: Record<string, unknown>, index = 0) {
  const replies = params.replies as Array<Record<string, unknown>> | undefined;
  const reply = replies?.[index];
  if (!reply) {
    throw new Error(`expected reply ${index}`);
  }
  return reply;
}

function registerCustomTelegramCommandMenu(
  customCommands: NonNullable<TelegramAccountConfig["customCommands"]>,
) {
  const setMyCommands = vi.fn().mockResolvedValue(undefined);
  const runtimeLog = vi.fn();

  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({ commands: { native: false } }),
    bot: {
      api: {
        setMyCommands,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      command: vi.fn(),
    } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    runtime: { log: runtimeLog } as unknown as RuntimeEnv,
    telegramCfg: { customCommands } as TelegramAccountConfig,
    nativeEnabled: false,
    nativeSkillsEnabled: false,
  });

  return { runtimeLog, setMyCommands };
}

describe("registerTelegramNativeCommands", () => {
  beforeAll(async () => {
    ({
      registerTelegramNativeCommands,
      parseTelegramNativeCommandCallbackData,
      resolveTelegramNativeCommandDisableBlockStreaming,
    } = await import("./bot-native-commands.js"));
  });

  beforeEach(() => {
    resetTelegramForumFlagCacheForTest();
    resetNativeCommandMenuMocks();
    resetPluginCommandMocks();
  });

  it("scopes skill commands when account binding exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
      bindings: [
        {
          agentId: "butler",
          match: { channel: "telegram", accountId: "bot-a" },
        },
      ],
    };

    registerTelegramNativeCommands(createNativeCommandTestParams(cfg, { accountId: "bot-a" }));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["butler"],
    });
  });

  it("scopes skill commands to default agent without a matching binding (#15599)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
    };

    registerTelegramNativeCommands(createNativeCommandTestParams(cfg, { accountId: "bot-a" }));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["main"],
    });
  });

  it("truncates Telegram command registration to 100 commands", async () => {
    const customCommands = Array.from({ length: 120 }, (_, index) => ({
      command: `cmd_${index}`,
      description: `Command ${index}`,
    }));
    const { runtimeLog, setMyCommands } = registerCustomTelegramCommandMenu(customCommands);

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toHaveLength(100);
    expect(registeredCommands).toEqual(customCommands.slice(0, 100));
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram limits bots to 100 commands. 120 configured; registering first 100. Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.",
    );
  });

  it("keeps sub-100 commands by shortening long descriptions to fit Telegram payload budget", async () => {
    const customCommands = Array.from({ length: 92 }, (_, index) => ({
      command: `cmd_${index}`,
      description: `Command ${index} ` + "x".repeat(120),
    }));
    const { runtimeLog, setMyCommands } = registerCustomTelegramCommandMenu(customCommands);

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toHaveLength(92);
    expect(
      registeredCommands.some(
        (entry) => entry.description.length < customCommands[0].description.length,
      ),
    ).toBe(true);
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram menu text exceeded the conservative 5700-character payload budget; shortening descriptions to keep 92 commands visible.",
    );
  });

  it("normalizes hyphenated native command names for Telegram registration", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const command = vi.fn();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command,
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    const registeredCommandNames = registeredCommands.map((entry) => entry.command);
    expect(registeredCommandNames).toContain("export_session");
    expect(registeredCommandNames).not.toContain("export-session");

    const registeredHandlers = command.mock.calls.map(([name]) => name);
    expect(registeredHandlers).toContain("export_session");
    expect(registeredHandlers).not.toContain("export-session");
  });

  it("registers only Telegram-safe command names across native, custom, and plugin sources", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      { name: "plugin-status", description: "Plugin status" },
      { name: "plugin@bad", description: "Bad plugin command" },
    ] as never);

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      telegramCfg: {
        customCommands: [
          { command: "custom-backup", description: "Custom backup" },
          { command: "custom!bad", description: "Bad custom command" },
        ],
      } as TelegramAccountConfig,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);

    expect(registeredCommands.length).toBeGreaterThan(0);
    const registeredCommandNames = registeredCommands.map((entry) => entry.command);
    for (const entry of registeredCommands) {
      expect(entry.command.includes("-")).toBe(false);
      expect(TELEGRAM_COMMAND_NAME_PATTERN.test(entry.command)).toBe(true);
    }

    expect(registeredCommandNames).toContain("export_session");
    expect(registeredCommandNames).toContain("custom_backup");
    expect(registeredCommandNames).toContain("plugin_status");
    expect(registeredCommandNames).not.toContain("plugin-status");
    expect(registeredCommandNames).not.toContain("custom-bad");
  });

  it("prefixes native command menu callback data so callback handlers can preserve native routing", async () => {
    const { bot, commandHandlers, sendMessage } = createCommandBot();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}, { bot, allowFrom: [200] }),
    });

    const handler = commandHandlers.get("fast");
    if (!handler) {
      throw new Error("expected fast command handler to be registered");
    }
    await handler(createPrivateCommandContext());

    const replyMarkup = sendMessage.mock.calls[0]?.[2]?.reply_markup as
      | TelegramInlineKeyboardReplyMarkup
      | undefined;
    const callbackData = collectCallbackData(replyMarkup);

    expect(callbackData).toEqual([
      "tgcmd:/fast status",
      "tgcmd:/fast on",
      "tgcmd:/fast off",
      "tgcmd:/fast default",
    ]);
    expect(parseTelegramNativeCommandCallbackData("tgcmd:/fast status")).toBe("/fast status");
    expect(parseTelegramNativeCommandCallbackData("tgcmd:/fast default")).toBe("/fast default");
    expect(parseTelegramNativeCommandCallbackData("tgcmd:fast status")).toBeNull();
  });

  it("passes agent-scoped media roots for plugin command replies with media", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
      bindings: [{ agentId: "work", match: { channel: "telegram", accountId: "default" } }],
    };

    const { handler, sendMessage } = registerPlugCommand({
      cfg,
      result: {
        text: "with media",
        mediaUrl: "/tmp/workspace-work/render.png",
      },
    });

    await handler(createPrivateCommandContext());

    const deliverParams = firstDeliverRepliesParams();
    const mediaLocalRoots = deliverParams.mediaLocalRoots as Array<string> | undefined;
    expect(mediaLocalRoots?.some((root) => /[\\/]\.openclaw[\\/]workspace-work$/.test(root))).toBe(
      true,
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("replies to unmatched plugin commands in the originating forum topic", async () => {
    const { handler, sendMessage } = registerPlugCommand();
    pluginCommandMocks.matchPluginCommand.mockReturnValue(null as never);

    await handler({
      match: "",
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        message_thread_id: 77,
        from: { id: 200, username: "bob" },
      },
    });

    expect(sendMessage.mock.calls[0]?.[0]).toBe(-1001234567890);
    expect(sendMessage.mock.calls[0]?.[1]).toBe("Command not found.");
    expect(
      (sendMessage.mock.calls[0]?.[2] as { message_thread_id?: number } | undefined)
        ?.message_thread_id,
    ).toBe(77);
  });

  it("uses nested streaming.block.enabled for native command block-streaming behavior", () => {
    expect(
      resolveTelegramNativeCommandDisableBlockStreaming({
        streaming: {
          block: {
            enabled: false,
          },
        },
      } as TelegramAccountConfig),
    ).toBe(true);
    expect(
      resolveTelegramNativeCommandDisableBlockStreaming({
        streaming: {
          block: {
            enabled: true,
          },
        },
      } as TelegramAccountConfig),
    ).toBe(false);
  });

  it("uses plugin command metadata to send and edit a Telegram progress placeholder", async () => {
    const { handler, sendMessage, deleteMessage } = registerPlugCommand({
      args: "now",
      command: {
        nativeProgressMessages: {
          telegram:
            "Running this command now...\n\nI'll edit this message with the final result when it's ready.",
        },
      },
      result: {
        text: "Command completed successfully",
      },
    });

    await handler(
      createPrivateCommandContext({
        match: "now",
      }),
    );

    expect(sendMessage.mock.calls[0]?.[0]).toBe(100);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("Running this command now");
    expect(sendMessage.mock.calls[0]?.[2]).toBeUndefined();
    const editCall = firstCall(
      editMessageTelegram as unknown as { mock: { calls: Array<Array<unknown>> } },
    );
    expect(editCall[0]).toBe(100);
    expect(editCall[1]).toBe(999);
    expect(String(editCall[2])).toContain("Command completed successfully");
    expect((editCall[3] as { accountId?: string } | undefined)?.accountId).toBe("default");
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    const hookParams = firstCallArg(
      emitTelegramMessageSentHooks as unknown as { mock: { calls: Array<Array<unknown>> } },
    );
    expect(hookParams.chatId).toBe("100");
    expect(hookParams.content).toBe("Command completed successfully");
    expect(hookParams.messageId).toBe(999);
    expect(hookParams.success).toBe(true);
  });

  it("preserves Telegram buttons when editing a metadata-driven progress placeholder", async () => {
    const { handler, sendMessage, deleteMessage } = registerPlugCommand({
      args: "now",
      command: {
        nativeProgressMessages: { telegram: "Working on it..." },
      },
      result: {
        text: "Choose an option",
        channelData: {
          telegram: {
            buttons: [[{ text: "Approve", callback_data: "approve" }]],
          },
        },
      },
    });

    await handler(createPrivateCommandContext({ match: "now" }));

    expect(sendMessage).toHaveBeenCalledWith(100, "Working on it...", undefined);
    const editCall = firstCall(
      editMessageTelegram as unknown as { mock: { calls: Array<Array<unknown>> } },
    );
    expect(editCall[0]).toBe(100);
    expect(editCall[1]).toBe(999);
    expect(editCall[2]).toBe("Choose an option");
    expect((editCall[3] as { buttons?: unknown } | undefined)?.buttons).toEqual([
      [{ text: "Approve", callback_data: "approve" }],
    ]);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("falls back to a normal reply when a metadata-driven progress result is not editable", async () => {
    const { handler, sendMessage, deleteMessage } = registerPlugCommand({
      args: "now",
      command: {
        nativeProgressMessages: { telegram: "Working on it..." },
      },
      result: {
        text: "rich output",
        mediaUrl: "/tmp/render.png",
      },
    });

    await handler(
      createPrivateCommandContext({
        match: "now",
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith(100, "Working on it...", undefined);
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(100, 999);
    expect(replyAt(firstDeliverRepliesParams()).mediaUrl).toBe("/tmp/render.png");
  });

  it("cleans up the progress placeholder before falling back after an edit failure", async () => {
    const { handler, sendMessage, deleteMessage } = registerPlugCommand({
      args: "now",
      command: {
        nativeProgressMessages: { telegram: "Working on it..." },
      },
      result: {
        text: "Command completed successfully",
      },
    });
    editMessageTelegram.mockRejectedValueOnce(new Error("message to edit not found"));

    await handler(createPrivateCommandContext({ match: "now" }));

    expect(sendMessage).toHaveBeenCalledWith(100, "Working on it...", undefined);
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(100, 999);
    expect(replyAt(firstDeliverRepliesParams()).text).toBe("Command completed successfully");
  });

  it("cleans up the progress placeholder when Telegram suppresses a local exec approval reply", async () => {
    const { handler, sendMessage, deleteMessage } = registerPlugCommand({
      args: "now",
      command: {
        nativeProgressMessages: { telegram: "Working on it..." },
      },
      result: {
        text: "Approval required.\n\n```txt\n/approve 7f423fdc allow-once\n```",
        channelData: {
          execApproval: {
            approvalId: "7f423fdc-1111-2222-3333-444444444444",
            approvalSlug: "7f423fdc",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      },
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm",
            },
          },
        },
      },
    });

    await handler(createPrivateCommandContext({ match: "now" }));

    expect(sendMessage).toHaveBeenCalledWith(100, "Working on it...", undefined);
    expect(deleteMessage).toHaveBeenCalledWith(100, 999);
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("sends plugin command error replies silently when silentErrorReplies is enabled", async () => {
    const { handler } = registerPlugCommand({
      cfg: {
        channels: {
          telegram: {
            silentErrorReplies: true,
          },
        },
      },
      result: {
        text: "plugin failed",
        isError: true,
      },
      registerOverrides: {
        telegramCfg: { silentErrorReplies: true } as TelegramAccountConfig,
      },
    });

    await handler(createPrivateCommandContext());

    const deliverParams = firstDeliverRepliesParams();
    expect(deliverParams.silent).toBe(true);
    expect(replyAt(deliverParams).isError).toBe(true);
  });

  it("forwards topic-scoped binding context to Telegram plugin commands", async () => {
    const { handler } = registerPlugCommand();

    await handler({
      match: "",
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        message_thread_id: 77,
        from: { id: 200, username: "bob" },
      },
    });

    const commandParams = firstExecutePluginCommandParams();
    expect(commandParams.channel).toBe("telegram");
    expect(commandParams.accountId).toBe("default");
    expect(commandParams.from).toBe("telegram:group:-1001234567890:topic:77");
    expect(commandParams.to).toBe("telegram:-1001234567890");
    expect(commandParams.messageThreadId).toBe(77);
  });

  it("treats Telegram forum #General commands as topic 1 when Telegram omits topic metadata", async () => {
    const getChat = vi.fn(async () => ({ id: -1001234567890, type: "supergroup", is_forum: true }));
    const { handler } = registerPlugCommand({
      botHarness: createCommandBot({ api: { getChat } }),
    });

    await handler({
      match: "",
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
        },
        from: { id: 200, username: "bob" },
      },
    });

    expect(getChat).toHaveBeenCalledWith(-1001234567890);
    const commandParams = firstExecutePluginCommandParams();
    expect(commandParams.accountId).toBe("default");
    expect(commandParams.from).toBe("telegram:group:-1001234567890:topic:1");
    expect(commandParams.to).toBe("telegram:-1001234567890");
    expect(commandParams.messageThreadId).toBe(1);
  });

  it("forwards direct-message binding context to Telegram plugin commands", async () => {
    const { handler } = registerPlugCommand();

    await handler(createPrivateCommandContext({ chatId: 100, userId: 200 }));

    const commandParams = firstExecutePluginCommandParams();
    expect(commandParams.channel).toBe("telegram");
    expect(commandParams.accountId).toBe("default");
    expect(commandParams.from).toBe("telegram:100");
    expect(commandParams.to).toBe("telegram:100");
    expect(commandParams.messageThreadId).toBeUndefined();
  });
});
