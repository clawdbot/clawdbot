import type { SlashCommandRegistry } from "../slash-commands.js";
import { getPluginVersionString, resolveRuntimeServiceVersion } from "./state.js";

const QQBOT_PLUGIN_GITHUB_URL = "https://github.com/openclaw/openclaw/tree/main/extensions/qqbot";
const QQBOT_UPGRADE_GUIDE_URL = "https://q.qq.com/qqbot/openclaw/upgrade.html";

export function registerBasicBotCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: "bot-help",
    description: "查看所有内置命令",
    usage: [
      `/bot-help`,
      ``,
      `查看所有可用的 QQBot 内置命令及其简要说明。`,
      `在命令后追加 ? 可查看详细用法。`,
    ].join("\n"),
    handler: (ctx) => {
      const isGroup = ctx.type === "group";
      const lines = [`### QQBot 内置命令`, ``];
      for (const [name, cmd] of registry.getAllCommands()) {
        if (isGroup && cmd.c2cOnly) {
          continue;
        }
        lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
      }
      lines.push(``, `> 插件版本 v${getPluginVersionString()}`);
      return lines.join("\n");
    },
  });

  registry.register({
    name: "bot-me",
    description: "查看当前发送者的账号ID",
    c2cOnly: true,
    usage: [`/bot-me`, ``, `显示当前发送者的账号ID`].join("\n"),
    handler: (ctx) => {
      return `你的账号ID：\`${ctx.senderId}\``;
    },
  });

  registry.register({
    name: "bot-ping",
    description: "测试 OpenClaw 与 QQ 之间的网络延迟",
    usage: [
      `/bot-ping`,
      ``,
      `测试当前 OpenClaw 宿主机与 QQ 服务器之间的网络延迟。`,
      `返回网络传输耗时和插件处理耗时。`,
    ].join("\n"),
    handler: (ctx) => {
      const now = Date.now();
      const eventTime = new Date(ctx.eventTimestamp).getTime();
      if (Number.isNaN(eventTime)) {
        return `✅ pong!`;
      }
      const totalMs = now - eventTime;
      const qqToPlugin = ctx.receivedAt - eventTime;
      const pluginProcess = now - ctx.receivedAt;
      const lines = [
        `✅ pong!`,
        ``,
        `⏱ 延迟：${totalMs}ms`,
        `  ├ 网络传输：${qqToPlugin}ms`,
        `  └ 插件处理：${pluginProcess}ms`,
      ];
      return lines.join("\n");
    },
  });

  registry.register({
    name: "bot-version",
    description: "查看 QQBot 插件版本和 OpenClaw 框架版本",
    c2cOnly: true,
    usage: [`/bot-version`, ``, `查看当前 QQBot 插件版本和 OpenClaw 框架版本。`].join("\n"),
    handler: async () => {
      const frameworkVersion = resolveRuntimeServiceVersion();
      const ver = getPluginVersionString();
      const lines = [
        `🦞 OpenClaw 框架版本：${frameworkVersion}`,
        `🤖 QQBot 插件版本：v${ver}`,
        `🌟 官方 GitHub 仓库：[点击前往](${QQBOT_PLUGIN_GITHUB_URL})`,
      ];
      return lines.join("\n");
    },
  });

  registry.register({
    name: "bot-upgrade",
    description: "查看 QQBot 升级指引",
    c2cOnly: true,
    usage: [`/bot-upgrade`, ``, `查看 QQBot 升级说明。`].join("\n"),
    handler: () =>
      [`📘 QQBot 升级指引：`, `[点击查看升级说明](${QQBOT_UPGRADE_GUIDE_URL})`].join("\n"),
  });
}
