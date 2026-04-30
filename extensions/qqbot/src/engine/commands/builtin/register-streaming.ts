import type { ApproveRuntimeGetter } from "../../adapter/commands.port.js";
import type { SlashCommandRegistry } from "../slash-commands.js";
import {
  getApproveRuntimeGetter,
  getPluginVersionString,
  resolveRuntimeServiceVersion,
} from "./state.js";

function isStreamingConfigEnabled(streaming: unknown): boolean {
  if (streaming === true) {
    return true;
  }
  if (streaming === false || streaming === undefined || streaming === null) {
    return false;
  }
  if (typeof streaming === "object") {
    const o = streaming as Record<string, unknown>;
    if (o.c2cStreamApi === true) {
      return true;
    }
    if (o.mode === "off") {
      return false;
    }
    return true;
  }
  return false;
}

export function registerStreamingCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: "bot-streaming",
    description: "一键开关流式消息",
    c2cOnly: true,
    usage: [
      `/bot-streaming on     开启流式消息`,
      `/bot-streaming off    关闭流式消息`,
      `/bot-streaming        查看当前流式消息状态`,
      ``,
      `开启后，AI 的回复会以流式形式逐步显示（打字机效果）。`,
      `注意：仅 C2C（私聊）支持流式消息。`,
    ].join("\n"),
    handler: async (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      const currentOn = isStreamingConfigEnabled(ctx.accountConfig?.streaming);

      if (!arg) {
        return [
          `📡 流式消息状态：${currentOn ? "✅ 已开启" : "❌ 已关闭"}`,
          ``,
          `使用 <qqbot-cmd-input text="/bot-streaming on" show="/bot-streaming on"/> 开启`,
          `使用 <qqbot-cmd-input text="/bot-streaming off" show="/bot-streaming off"/> 关闭`,
        ].join("\n");
      }

      if (arg !== "on" && arg !== "off") {
        return `❌ 参数错误，请使用 on 或 off\n\n示例：/bot-streaming on`;
      }

      const wantOn = arg === "on";
      if (wantOn === currentOn) {
        return `📡 流式消息已经是${wantOn ? "开启" : "关闭"}状态，无需操作`;
      }

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
          `可通过以下命令手动开启流式消息：`,
          ``,
          `\`\`\`shell`,
          `# 1. 开启流式消息`,
          `openclaw config set channels.qqbot.streaming true`,
          ``,
          `# 2. 重启网关使配置生效`,
          `openclaw gateway restart`,
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
        const newVal: unknown = wantOn;

        if (accountId !== "default") {
          const prevAccounts =
            (qqbot.accounts as Record<string, Record<string, unknown>> | undefined) ?? {};
          const nextAccounts = { ...prevAccounts };
          const acct = { ...nextAccounts[accountId] };
          acct.streaming = newVal;
          nextAccounts[accountId] = acct;
          qqbot.accounts = nextAccounts;
        } else {
          qqbot.streaming = newVal;
          const accs = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
          if (accs?.default && typeof accs.default === "object") {
            const nextAccs = { ...accs };
            const def = { ...accs.default, streaming: newVal };
            nextAccs.default = def;
            qqbot.accounts = nextAccs;
          }
        }

        await configApi.replaceConfigFile({ nextConfig: currentCfg, afterWrite: { mode: "auto" } });

        return [
          `✅ 流式消息已${wantOn ? "开启" : "关闭"}`,
          ``,
          wantOn ? `AI 的回复将以流式形式逐步显示（仅私聊生效）。` : `AI 的回复将恢复为完整发送。`,
        ].join("\n");
      } catch (err: unknown) {
        return `❌ 配置写入失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
