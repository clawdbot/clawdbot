import type { SlashCommandRegistry } from "../slash-commands.js";
import { buildBotLogsResult } from "./log-helpers.js";

export function registerLogCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: "bot-logs",
    description: "导出本地日志文件",
    requireAuth: true,
    c2cOnly: true,
    usage: [
      `/bot-logs`,
      ``,
      `导出最近的 OpenClaw 日志文件（最多 4 个文件）。`,
      `每个文件只保留最后 1000 行，并作为附件返回。`,
    ].join("\n"),
    handler: () => {
      return buildBotLogsResult();
    },
  });
}
