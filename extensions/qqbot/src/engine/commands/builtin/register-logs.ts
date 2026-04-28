import type { SlashCommandRegistry } from "../slash-commands.js";
import { buildBotLogsResult, hasExplicitCommandAllowlist } from "./log-helpers.js";

export function registerLogCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: "bot-logs",
    description: "导出本地日志文件",
    requireAuth: true,
    usage: [
      `/bot-logs`,
      ``,
      `导出最近的 OpenClaw 日志文件（最多 4 个文件）。`,
      `每个文件只保留最后 1000 行，并作为附件返回。`,
    ].join("\n"),
    handler: (ctx) => {
      if (!hasExplicitCommandAllowlist(ctx.accountConfig)) {
        return `⛔ 权限不足：请先在 channels.qqbot.allowFrom（或对应账号 allowFrom）中配置明确的发送者列表后再使用 /bot-logs。`;
      }
      return buildBotLogsResult();
    },
  });
}
