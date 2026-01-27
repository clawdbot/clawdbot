import { describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

const getPluginCommandSpecs = vi.hoisted(() => vi.fn());
const matchPluginCommand = vi.hoisted(() => vi.fn());
const executePluginCommand = vi.hoisted(() => vi.fn());

vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs,
  matchPluginCommand,
  executePluginCommand,
}));

const deliverReplies = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./bot/delivery.js", () => ({ deliverReplies }));

vi.mock("./pairing-store.js", () => ({
  readTelegramAllowFromStore: vi.fn(async () => []),
}));

describe("registerTelegramNativeCommands (plugin auth)", () => {
  it("allows requireAuth:false plugin command even when sender is unauthorized", async () => {
    const command = {
      name: "plugin",
      description: "Plugin command",
      requireAuth: false,
      handler: vi.fn(),
    } as const;

    getPluginCommandSpecs.mockReturnValue([{ name: "plugin", description: "Plugin command" }]);
    matchPluginCommand.mockReturnValue({ command, args: undefined });
    executePluginCommand.mockResolvedValue({ text: "ok" });

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(),
      },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    const cfg = {} as MoltbotConfig;
    const telegramCfg = {} as TelegramAccountConfig;
    const resolveGroupPolicy = () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as RuntimeEnv,
      accountId: "default",
      telegramCfg,
      allowFrom: ["999"],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: false,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    const ctx = {
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "nope" },
        message_id: 10,
        date: 123456,
      },
      match: "",
    };

    await handlers.plugin?.(ctx);

    expect(matchPluginCommand).toHaveBeenCalled();
    expect(executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        isAuthorizedSender: false,
      }),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "ok" }],
      }),
    );
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
