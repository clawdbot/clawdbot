// Telegram plugin module implements bot behavior.
import { createTelegramBotCore, setTelegramBotRuntimeForTest } from "./bot-core.js";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import type { TelegramBotOptions } from "./bot.types.js";

export { setTelegramBotRuntimeForTest };

export function createTelegramBot(
  opts: TelegramBotOptions,
): ReturnType<typeof createTelegramBotCore> {
  return createTelegramBotCore({
    ...opts,
    telegramDeps: opts.telegramDeps ?? defaultTelegramBotDeps,
  });
}
