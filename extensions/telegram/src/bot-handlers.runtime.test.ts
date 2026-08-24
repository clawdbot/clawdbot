// Telegram tests cover bot handler registration behavior.
import { Bot } from "grammy";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { registerTelegramHandlers } from "./bot-handlers.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";

describe("registerTelegramHandlers", () => {
  it("registers middleware in transport order", () => {
    const bot = new Bot("123456:handler-registration-test");
    const on = vi.spyOn(bot, "on");
    const params: RegisterTelegramHandlerParams = {
      cfg: {},
      accountId: "default",
      ownerAgentId: "main",
      bot,
      mediaMaxBytes: 1,
      opts: { token: "tok" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      telegramCfg: {},
      telegramDeps: defaultTelegramBotDeps,
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({}),
      shouldSkipUpdate: () => false,
      processMessage: vi.fn<RegisterTelegramHandlerParams["processMessage"]>(),
      logger: getChildLogger({ module: "telegram/handler-registration-test" }),
    };

    registerTelegramHandlers(params);

    expect(on.mock.calls.map(([trigger]) => trigger)).toEqual([
      "message_reaction",
      "poll",
      "poll_answer",
      "callback_query",
      "message:migrate_to_chat_id",
      "message",
      "edited_message",
      "channel_post",
      "edited_channel_post",
    ]);
  });
});
