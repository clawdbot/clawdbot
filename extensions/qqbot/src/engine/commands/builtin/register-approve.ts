import type { ApproveRuntimeGetter } from "../../adapter/commands.port.js";
import type { SlashCommandRegistry } from "../slash-commands.js";
import { getApproveRuntimeGetter } from "./state.js";

export function registerApproveCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: "bot-approve",
    description: "管理命令执行审批配置",
    requireAuth: true,
    c2cOnly: true,
    usage: [
      `/bot-approve            查看操作指引`,
      `/bot-approve on         开启审批（白名单模式，推荐）`,
      `/bot-approve off        关闭审批，命令直接执行`,
      `/bot-approve always     始终审批，每次执行都需审批`,
      `/bot-approve reset      恢复框架默认值`,
      `/bot-approve status     查看当前审批配置`,
    ].join("\n"),
    handler: async (ctx) => {
      const arg = ctx.args.trim().toLowerCase();

      let runtime: ReturnType<NonNullable<ApproveRuntimeGetter>>;
      try {
        const getter = getApproveRuntimeGetter();
        if (!getter) {
          throw new Error("runtime not available");
        }
        runtime = getter();
      } catch {
        return [
          `🔐 命令执行审批配置`,
          ``,
          `❌ 当前环境不支持在线配置修改，请通过 CLI 手动配置：`,
          ``,
          `\`\`\`shell`,
          `# 开启审批（白名单模式）`,
          `openclaw config set tools.exec.security allowlist`,
          `openclaw config set tools.exec.ask on-miss`,
          ``,
          `# 关闭审批`,
          `openclaw config set tools.exec.security full`,
          `openclaw config set tools.exec.ask off`,
          `\`\`\``,
        ].join("\n");
      }

      const configApi = runtime.config;

      const loadExecConfig = () => {
        const cfg = configApi.current();
        const tools = ((cfg as Record<string, unknown>).tools ?? {}) as Record<string, unknown>;
        const exec = (tools.exec ?? {}) as Record<string, unknown>;
        const security = typeof exec.security === "string" ? exec.security : "deny";
        const ask = typeof exec.ask === "string" ? exec.ask : "on-miss";
        return { security, ask };
      };

      const writeExecConfig = async (security: string, ask: string) => {
        const cfg = structuredClone(configApi.current() as Record<string, unknown>);
        const tools = (cfg.tools ?? {}) as Record<string, unknown>;
        const exec = (tools.exec ?? {}) as Record<string, unknown>;
        exec.security = security;
        exec.ask = ask;
        tools.exec = exec;
        cfg.tools = tools;
        await configApi.replaceConfigFile({ nextConfig: cfg, afterWrite: { mode: "auto" } });
      };

      const formatStatus = (security: string, ask: string) => {
        const secIcon = security === "full" ? "🟢" : security === "allowlist" ? "🟡" : "🔴";
        const askIcon = ask === "off" ? "🟢" : ask === "always" ? "🔴" : "🟡";
        return [
          `🔐 当前审批配置`,
          ``,
          `${secIcon} 安全模式 (security): **${security}**`,
          `${askIcon} 审批模式 (ask): **${ask}**`,
          ``,
          security === "deny"
            ? `⚠️ 当前为 deny 模式，所有命令执行被拒绝`
            : security === "full" && ask === "off"
              ? `✅ 所有命令无需审批直接执行`
              : security === "allowlist" && ask === "on-miss"
                ? `🛡️ 白名单命令直接执行，其余需审批`
                : ask === "always"
                  ? `🔒 每次命令执行都需要人工审批`
                  : `ℹ️ security=${security}, ask=${ask}`,
        ].join("\n");
      };

      if (!arg) {
        return [
          `🔐 命令执行审批配置`,
          ``,
          `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
          `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
          `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
          `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
          `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
        ].join("\n");
      }

      if (arg === "status") {
        const { security, ask } = loadExecConfig();
        return [
          formatStatus(security, ask),
          ``,
          `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批`,
          `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
          `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
          `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
        ].join("\n");
      }

      if (arg === "on") {
        try {
          await writeExecConfig("allowlist", "on-miss");
          return [
            `✅ 审批已开启`,
            ``,
            `• security = allowlist（白名单模式）`,
            `• ask = on-miss（未命中白名单时需审批）`,
            ``,
            `已批准的命令自动加入白名单，下次直接执行。`,
          ].join("\n");
        } catch (err: unknown) {
          return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (arg === "off") {
        try {
          await writeExecConfig("full", "off");
          return [
            `✅ 审批已关闭`,
            ``,
            `• security = full（允许所有命令）`,
            `• ask = off（不需要审批）`,
            ``,
            `⚠️ 所有命令将直接执行，不会弹出审批确认。`,
          ].join("\n");
        } catch (err: unknown) {
          return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (arg === "always" || arg === "strict") {
        try {
          await writeExecConfig("allowlist", "always");
          return [
            `✅ 已切换为严格审批模式`,
            ``,
            `• security = allowlist`,
            `• ask = always（每次执行都需审批）`,
            ``,
            `每个命令都会弹出审批按钮，需手动确认。`,
          ].join("\n");
        } catch (err: unknown) {
          return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (arg === "reset") {
        try {
          const cfg = structuredClone(configApi.current() as Record<string, unknown>);
          const tools = (cfg.tools ?? {}) as Record<string, unknown>;
          const exec = (tools.exec ?? {}) as Record<string, unknown>;
          delete exec.security;
          delete exec.ask;
          if (Object.keys(exec).length === 0) {
            delete tools.exec;
          } else {
            tools.exec = exec;
          }
          if (Object.keys(tools).length === 0) {
            delete cfg.tools;
          } else {
            cfg.tools = tools;
          }
          await configApi.replaceConfigFile({ nextConfig: cfg, afterWrite: { mode: "auto" } });
          return [
            `✅ 审批配置已重置`,
            ``,
            `已移除 tools.exec.security 和 tools.exec.ask`,
            `框架将使用默认值（security=deny, ask=on-miss）`,
            ``,
            `如需开启命令执行，请使用 /bot-approve on`,
          ].join("\n");
        } catch (err: unknown) {
          return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return [
        `❌ 未知参数: ${arg}`,
        ``,
        `可用选项: on | off | always | reset | status`,
        `输入 /bot-approve ? 查看详细用法`,
      ].join("\n");
    },
  });
}
