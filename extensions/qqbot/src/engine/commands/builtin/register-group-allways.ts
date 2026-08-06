// 导入运行时配置缓存清除函数，确保配置更新后 getRuntimeConfig() 能读取到最新值
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
// Qqbot plugin module implements register group allways behavior.
import type { ApproveRuntimeGetter } from "../../adapter/commands.port.js";
import type { SlashCommandRegistry } from "../slash-commands.js";
import {
  getApproveRuntimeGetter,
  getPluginVersionString,
  resolveRuntimeServiceVersion,
} from "./state.js";

export function registerGroupAllwaysCommand(registry: SlashCommandRegistry): void {
  registry.register({
    name: "bot-group-allways",
    description: "修改群消息默认响应模式",
    requireAuth: true,
    c2cOnly: true,
    usage: [
      `/bot-group-allways on   AI 自主判断何时发言（无需 @）`,
      `/bot-group-allways off  仅在被 @ 时回复`,
      `/bot-group-allways      查看当前设置`,
      ``,
      `设为 on 后，AI 会自主判断每条消息是否需要回复（无需 @）。`,
      `仍可通过 groups.{groupId}.requireMention 对单个群覆盖。`,
      ``,
      `优先级：具体群配置 > 通配符 "*" > defaultRequireMention（本指令）> 默认 true`,
    ].join("\n"),
    handler: async (ctx) => {
      const arg = ctx.args.trim().toLowerCase();

      // 读取当前 defaultRequireMention 状态
      const currentVal = ctx.accountConfig?.defaultRequireMention;
      const currentRequireMention = currentVal ?? true; // 未设置时硬编码默认为 true

      // 无参数：查看当前状态
      if (!arg) {
        return [
          `🤖 群自主发言状态：${currentRequireMention ? "❌ 仅被 @ 时回复" : "✅ 自主判断何时发言"}`,
          `使用 <qqbot-cmd-input text="/bot-group-allways on" show="/bot-group-allways on"/> 设为自主发言`,
          `使用 <qqbot-cmd-input text="/bot-group-allways off" show="/bot-group-allways off"/> 设为仅被 @ 时回复`,
        ].join("\n");
      }

      if (arg !== "on" && arg !== "off") {
        return `❌ 参数错误，请使用 on 或 off\n\n示例：/bot-group-allways on`;
      }

      const newRequireMention = arg === "off"; // on=自主发言(requireMention=false), off=仅被@时回复(requireMention=true)

      // 如果状态没变，直接返回
      if (newRequireMention === currentRequireMention) {
        return `🤖 群自主发言已经是"${arg}"状态，无需操作`;
      }

      // 获取运行时配置 API
      let runtime: ReturnType<NonNullable<ApproveRuntimeGetter>>;
      try {
        const getter = getApproveRuntimeGetter();
        if (!getter) {
          throw new Error("runtime not available");
        }
        runtime = getter();
      } catch {
        const fwVer = resolveRuntimeServiceVersion();
        const ver = getPluginVersionString();
        return [
          `❌ 当前版本不支持该指令`,
          ``,
          `🦞框架版本：${fwVer}`,
          `🤖QQBot 插件版本：v${ver}`,
          ``,
          `可通过以下命令手动设置：`,
          ``,
          `\`\`\`shell`,
          `# 设为 AI 自主判断何时发言（defaultRequireMention=false）`,
          `openclaw config set channels.qqbot.defaultRequireMention false`,
          `# 或设为仅被 @ 时回复（defaultRequireMention=true）`,
          `openclaw config set channels.qqbot.defaultRequireMention true`,
          `\`\`\``,
        ].join("\n");
      }

      try {
        const configApi = runtime.config;
        const currentCfg = structuredClone(configApi.current() as Record<string, unknown>);
        const qqbot = ((currentCfg.channels ?? {}) as Record<string, unknown>).qqbot as
          | Record<string, unknown>
          | undefined;

        if (!qqbot) {
          return `❌ 配置文件中未找到 qqbot 通道配置`;
        }

        const accountId = ctx.accountId;
        const isNamedAccount =
          accountId !== "default" &&
          Boolean(
            (qqbot.accounts as Record<string, Record<string, unknown>> | undefined)?.[accountId],
          );

        if (isNamedAccount) {
          // 命名账户：更新 accounts.{accountId}.defaultRequireMention
          const accounts = (qqbot.accounts as Record<string, Record<string, unknown>>) ?? {};
          const nextAccounts = { ...accounts };
          const acct = { ...nextAccounts[accountId] };
          acct.defaultRequireMention = newRequireMention;
          nextAccounts[accountId] = acct;
          qqbot.accounts = nextAccounts;
        } else {
          // 默认账户：更新 qqbot.defaultRequireMention
          qqbot.defaultRequireMention = newRequireMention;
        }

        await configApi.replaceConfigFile({ nextConfig: currentCfg, afterWrite: { mode: "auto" } });

        // 清除运行时配置缓存，确保 getRuntimeConfig() 下次调用时重新加载最新配置
        clearRuntimeConfigSnapshot();

        return [
          `✅ 群自主发言已设置为 ${newRequireMention ? "**off**（仅被 @ 时回复）" : "**on**（AI 自主判断何时发言）"}`,
          ``,
          newRequireMention
            ? `仅在被 @ 机器人才会回复。`
            : `AI 将自主判断群消息是否需要回复，无需被 @ 即可发言。`,
        ].join("\n");
      } catch (err: unknown) {
        return `❌ 配置写入失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
