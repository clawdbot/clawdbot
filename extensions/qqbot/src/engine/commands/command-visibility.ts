// Qqbot plugin module classifies slash-command visibility for QQ group chats.
import type { QQBotGroupCommandLevel } from "../config/group.js";

type GroupCommandVisibility = "group" | "hidden" | "private" | "unknown";

export const PRIVATE_CHAT_ONLY_TEXT = "该命令仅限私聊使用，请在私聊中发送。";

const GROUP_VISIBLE_CORE_COMMANDS = new Set(["help", "btw", "side", "stop"]);

const STRICT_CORE_COMMANDS = new Set(["new", "reset"]);

const GROUP_HIDDEN_CORE_COMMANDS = new Set([
  "goal",
  "usage",
  "activation",
  "send",
  "reset",
  "new",
  "name",
  "compact",
  "think",
  "thinking",
  "t",
  "fast",
  "reasoning",
  "reason",
  "queue",
]);

const PRIVATE_ONLY_CORE_COMMANDS = new Set([
  "commands",
  "tools",
  "skill",
  "diagnostics",
  "openclaw",
  "tasks",
  "allowlist",
  "approve",
  "context",
  "export-session",
  "export",
  "export-trajectory",
  "trajectory",
  "tts",
  "whoami",
  "id",
  "session",
  "subagents",
  "acp",
  "focus",
  "unfocus",
  "agents",
  "steer",
  "tell",
  "config",
  "mcp",
  "plugins",
  "plugin",
  "debug",
  "status",
  "restart",
  "trace",
  "verbose",
  "v",
  "elevated",
  "elev",
  "exec",
  "model",
  "models",
  "bash",
]);

function parseSlashCommandName(content: string | undefined | null): string | undefined {
  const trimmed = (content ?? "").trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const firstToken = trimmed.slice(1).split(/\s+/, 1)[0]?.trim().toLowerCase() ?? "";
  const commandName = firstToken.split(/[@:：]/u, 1)[0] ?? "";
  return commandName || undefined;
}

export function classifyCoreCommandForGroup(
  content: string | undefined | null,
  commandLevel: QQBotGroupCommandLevel = "all",
): {
  commandName?: string;
  visibility: GroupCommandVisibility;
} {
  const commandName = parseSlashCommandName(content);
  if (!commandName) {
    return { visibility: "unknown" };
  }
  if (commandLevel === "all") {
    return {
      commandName,
      visibility: GROUP_VISIBLE_CORE_COMMANDS.has(commandName) ? "group" : "hidden",
    };
  }
  if (commandLevel === "strict") {
    if (commandName === "stop") {
      return { commandName, visibility: "group" };
    }
    if (STRICT_CORE_COMMANDS.has(commandName)) {
      return { commandName, visibility: "hidden" };
    }
    return { commandName, visibility: "private" };
  }
  if (GROUP_VISIBLE_CORE_COMMANDS.has(commandName)) {
    return { commandName, visibility: "group" };
  }
  if (GROUP_HIDDEN_CORE_COMMANDS.has(commandName)) {
    return { commandName, visibility: "hidden" };
  }
  if (PRIVATE_ONLY_CORE_COMMANDS.has(commandName)) {
    return { commandName, visibility: "private" };
  }
  return { commandName, visibility: "unknown" };
}
