import { loadConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { handleTelegramAction } from "./telegram-actions.js";
import { TelegramToolSchema } from "./telegram-schema.js";

export function createTelegramTool(): AnyAgentTool {
  return {
    label: "Telegram",
    name: "telegram",
    description: "Send messages and manage reactions on Telegram.",
    parameters: TelegramToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = loadConfig();
      return await handleTelegramAction(params, cfg);
    },
  };
}
