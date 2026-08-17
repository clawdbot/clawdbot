import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
// Telegram tests cover bot native commands plugin behavior.
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramTopicCommandContext } from "./bot-native-commands.fixture-test-support.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
  editMessageTelegram,
  emitTelegramMessageSentHooks,
  resetNativeCommandMenuMocks,
} from "./bot-native-commands.menu-test-support.js";
import { resetTelegramForumFlagCacheForTest } from "./bot/helpers.js";

const pluginSessionMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntry: pluginSessionMocks.getSessionEntry,
    resolveStorePath: pluginSessionMocks.resolveStorePath,
  };
});
type CommandBotHarness = ReturnType<typeof createCommandBot>;
type PlugCommandHarnessParams = {
  botHarness?: CommandBotHarness;
  cfg?: OpenClawConfig;
  command?: Record<string, unknown>;
  acceptsArgs?: boolean;
  args?: string;
  result?: Record<string, unknown>;
  registerOverrides?: Partial<Parameters<typeof registerTelegramNativeCommands>[0]>;
};

const pluginCommandHandler = vi.fn(async (_ctx: Record<string, unknown>) => ({ text: "ok" }));

function registerTestPluginCommand(params: {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  command?: Record<string, unknown>;
  result?: Record<string, unknown>;
}) {
  expect(
    registerPluginCommand(`test-${params.name}`, {
      name: params.name,
      description: params.description,
      acceptsArgs: params.acceptsArgs,
      requireAuth: false,
      ...params.command,
      handler: async (ctx) => {
        const handlerResult = await pluginCommandHandler(ctx as unknown as Record<string, unknown>);
        return params.result ?? handlerResult;
      },
    }),
  ).toEqual({ ok: true });
}

function primePlugCommand(params: PlugCommandHarnessParams = {}) {
  registerTestPluginCommand({
    name: "plug",
    description: "Plugin command",
    acceptsArgs: params.acceptsArgs ?? true,
    command: params.command,
    result: params.result,
  });
}

function registerPlugCommand(params: PlugCommandHarnessParams = {}) {
  const botHarness = params.botHarness ?? createCommandBot();
  primePlugCommand(params);
  registerTelegramNativeCommands({
    ...createNativeCommandTestParams(params.cfg ?? {}, {
      bot: botHarness.bot,
    }),
    ...params.registerOverrides,
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

function firstCall(mock: { mock: { calls: Array<Array<unknown>> } }) {
  const call = mock.mock.calls.at(0);
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
    pluginCommandHandler as unknown as {
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

resetPluginRuntimeStateForTest();
setActivePluginRegistry(createEmptyPluginRegistry());
const { registerTelegramNativeCommands } = await import("./bot-native-commands.js");
registerTelegramNativeCommands(createNativeCommandTestParams({}));

describe("registerTelegramNativeCommands", () => {
  beforeEach(() => {
    resetTelegramForumFlagCacheForTest();
    resetNativeCommandMenuMocks();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginCommands();
    pluginCommandHandler.mockReset().mockResolvedValue({ text: "ok" });
    pluginSessionMocks.getSessionEntry.mockReset().mockReturnValue(undefined);
    pluginSessionMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  });

  it("passes agent-scoped media roots for plugin command replies with media", async () => {
    const mediaMaxBytes = 50 * 1024 * 1024;
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
      registerOverrides: {
        mediaMaxBytes,
      } as Partial<Parameters<typeof registerTelegramNativeCommands>[0]>,
    });

    await handler(createPrivateCommandContext());

    const deliverParams = firstDeliverRepliesParams();
    expect(deliverParams.mediaMaxBytes).toBe(mediaMaxBytes);
    const mediaLocalRoots = deliverParams.mediaLocalRoots as Array<string> | undefined;
    expect(mediaLocalRoots?.some((root) => /[\\/]\.openclaw[\\/]workspace-work$/.test(root))).toBe(
      true,
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("delivers presentation-only tables returned by plugin commands", async () => {
    const presentation = {
      title: "FY25 outlook",
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage"],
          rows: [["Acme", "Won"]],
        },
      ],
    };
    const { handler } = registerPlugCommand({ result: { presentation } });

    await handler(createPrivateCommandContext());

    expect(replyAt(firstDeliverRepliesParams())).toMatchObject({ presentation });
    expect(replyAt(firstDeliverRepliesParams()).text).toBeUndefined();
  });

  it("delivers Telegram button-only plugin command replies", async () => {
    const buttons = [[{ text: "Retry", callback_data: "retry" }]];
    const { handler } = registerPlugCommand({
      result: { channelData: { telegram: { buttons } } },
    });

    await handler(createPrivateCommandContext());

    expect(replyAt(firstDeliverRepliesParams())).toEqual({
      channelData: { telegram: { buttons } },
    });
  });

  it("targets reaction-only plugin replies at the invoking command message", async () => {
    const { handler } = registerPlugCommand({
      result: { channelData: { telegram: { reaction: { emoji: "🔥" } } } },
    });

    await handler(createPrivateCommandContext({ messageId: 321 }));

    const deliveryParams = firstDeliverRepliesParams();
    expect(replyAt(deliveryParams)).toEqual({
      replyToId: "321",
      channelData: { telegram: { reaction: { emoji: "🔥" } } },
    });
    expect(deliveryParams.replyToMode).toBe("all");
  });

  it("uses the empty-response fallback for unrelated metadata-only plugin results", async () => {
    const { handler } = registerPlugCommand({
      result: { channelData: { plugin: { traceId: "trace-1" } } },
    });

    await handler(createPrivateCommandContext());

    expect(replyAt(firstDeliverRepliesParams())).toEqual({
      text: "No response generated. Please try again.",
    });
  });

  it("replies to unmatched plugin commands in the originating forum topic", async () => {
    const { handler, sendMessage } = registerPlugCommand({ acceptsArgs: false });

    await handler({
      match: "unexpected",
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

    const sendMessageCall = firstCall(sendMessage);
    expect(sendMessageCall[0]).toBe(-1001234567890);
    expect(sendMessageCall[1]).toBe("Command not found.");
    expect(
      (sendMessageCall[2] as { message_thread_id?: number } | undefined)?.message_thread_id,
    ).toBe(77);
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

    const sendMessageCall = firstCall(sendMessage);
    expect(sendMessageCall[0]).toBe(100);
    expect(String(sendMessageCall[1])).toContain("Running this command now");
    expect(sendMessageCall[2]).toBeUndefined();
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

  it("delivers reactions after cleaning up a metadata-driven progress placeholder", async () => {
    const { handler, sendMessage, deleteMessage } = registerPlugCommand({
      args: "now",
      command: {
        nativeProgressMessages: { telegram: "Working on it..." },
      },
      result: {
        text: "Command completed successfully",
        channelData: { telegram: { reaction: { emoji: "🔥" } } },
      },
    });

    await handler(createPrivateCommandContext({ match: "now", messageId: 321 }));

    expect(sendMessage).toHaveBeenCalledWith(100, "Working on it...", undefined);
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(100, 999);
    const deliveryParams = firstDeliverRepliesParams();
    expect(deliveryParams.replyToMode).toBe("all");
    expect(replyAt(deliveryParams)).toEqual({
      text: "Command completed successfully",
      replyToId: "321",
      channelData: { telegram: { reaction: { emoji: "🔥" } } },
    });
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

  it("falls back to a normal reply when a progress result has presentation controls", async () => {
    const presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Approve", action: { type: "callback", value: "/approve yes" } }],
        },
      ],
    };
    const { handler, sendMessage, deleteMessage } = registerPlugCommand({
      args: "now",
      command: {
        nativeProgressMessages: { telegram: "Working on it..." },
      },
      result: {
        text: "Approval required",
        presentation,
      },
    });

    await handler(createPrivateCommandContext({ match: "now" }));

    expect(sendMessage).toHaveBeenCalledWith(100, "Working on it...", undefined);
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(100, 999);
    expect(replyAt(firstDeliverRepliesParams())).toMatchObject({
      text: "Approval required",
      presentation,
    });
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

  it("uses rich messages for plugin command replies when enabled", async () => {
    const { handler } = registerPlugCommand({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
          },
        },
      },
      registerOverrides: {
        telegramCfg: { richMessages: true } as TelegramAccountConfig,
      },
    });

    await handler(createPrivateCommandContext());

    expect(firstDeliverRepliesParams().richMessages).toBe(true);
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

  it("suppresses the fallback reply when a plugin command returns suppressReply: true", async () => {
    const { handler } = registerPlugCommand({
      result: { suppressReply: true },
    });

    await handler(createPrivateCommandContext());

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("uses bot topic capability for Telegram plugin command DM topic session keys", async () => {
    const { handler } = registerPlugCommand();

    await handler({
      ...createPrivateCommandContext({ chatId: 100, userId: 200, threadId: 77 }),
      me: { has_topics_enabled: true },
    });

    const commandParams = firstExecutePluginCommandParams();
    expect(commandParams.sessionKey).toBe("agent:main:main:thread:100:77");
    const deliveryParams = firstDeliverRepliesParams();
    expect(deliveryParams.sessionKeyForInternalHooks).toBe("agent:main:main:thread:100:77");
  });

  it("passes persisted topic session identity to plugin commands", async () => {
    pluginSessionMocks.getSessionEntry.mockReturnValue({
      authProfileOverride: "openai:owner@example.com",
      sessionId: "sess-topic",
      updatedAt: 1,
    });
    const { handler } = registerPlugCommand({
      cfg: { commands: { allowFrom: { telegram: ["200"] } } } as OpenClawConfig,
    });

    await handler(
      createTelegramTopicCommandContext({ match: "bind --cwd /tmp/work", threadId: 42 }),
    );

    expect(firstExecutePluginCommandParams()).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
        sessionId: "sess-topic",
        messageThreadId: 42,
      }),
    );
  });

  it.each([
    {
      name: "creates a SQLite marker when the entry has no file",
      entry: { sessionId: "sess-main", updatedAt: 1 } satisfies SessionEntry,
    },
    {
      name: "keeps the canonical SQLite marker",
      entry: {
        sessionId: "sess-main",
        sessionFile: "sqlite:main:sess-main:/tmp/openclaw-sessions.json",
        updatedAt: 1,
      } satisfies SessionEntry,
    },
    {
      name: "replaces a stale legacy transcript path",
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        updatedAt: 1,
      } satisfies SessionEntry,
    },
  ])("$name", async ({ entry }) => {
    pluginSessionMocks.getSessionEntry.mockReturnValue(entry);
    const { handler } = registerPlugCommand();

    await handler(createPrivateCommandContext({ match: "status" }));

    expect(firstExecutePluginCommandParams()).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        sessionFile: "sqlite:main:sess-main:/tmp/openclaw-sessions.json",
      }),
    );
  });

  it("sends an empty-response fallback when a plugin command returns undefined", async () => {
    pluginCommandHandler.mockResolvedValueOnce(undefined as never);
    const { handler } = registerPlugCommand();

    await handler(createPrivateCommandContext({ match: "status" }));

    expect(replyAt(firstDeliverRepliesParams())).toEqual({
      text: "No response generated. Please try again.",
    });
  });
});
