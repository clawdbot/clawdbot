/**
 * Slash command registration and dispatch framework.
 *
 * This module provides the type definitions, command registry, and
 * `matchSlashCommand` dispatcher that both plugin versions share.
 *
 * Concrete command implementations (e.g. `/bot-ping`, `/bot-logs`) are
 * registered by the upper-layer bootstrap code, NOT defined here.
 *
 * Zero external dependencies.
 */

// ============ Types ============

/** Slash command context (message metadata plus runtime state). */
export interface SlashCommandContext {
  /** Message type. */
  type: "c2c" | "guild" | "dm" | "group";
  /** Sender ID. */
  senderId: string;
  /** Sender display name. */
  senderName?: string;
  /** Message ID used for passive replies. */
  messageId: string;
  /** Event timestamp from QQ as an ISO string. */
  eventTimestamp: string;
  /** Local receipt timestamp in milliseconds. */
  receivedAt: number;
  /** Raw message content. */
  rawContent: string;
  /** Command arguments after stripping the command name. */
  args: string;
  /** Channel ID for guild messages. */
  channelId?: string;
  /** Group openid for group messages. */
  groupOpenid?: string;
  /** Account ID. */
  accountId: string;
  /** Bot App ID. */
  appId: string;
  /** Account config available to the command handler. */
  accountConfig?: Record<string, unknown>;
  /** Whether the sender is authorized per the allowFrom config. */
  commandAuthorized: boolean;
  /** Queue snapshot for the current sender. */
  queueSnapshot: QueueSnapshot;
}

/** Queue status snapshot. */
export interface QueueSnapshot {
  totalPending: number;
  activeUsers: number;
  maxConcurrentUsers: number;
  senderPending: number;
}

/** Slash command result: text, a text+file result, or null to skip handling. */
export type SlashCommandResult = string | SlashCommandFileResult | null;

/** Slash command result that sends text first and then a local file. */
interface SlashCommandFileResult {
  text: string;
  /** Local file path to send. */
  filePath: string;
}

/** Slash command definition. */
interface SlashCommand {
  /** Command name without the leading slash. */
  name: string;
  /** Short description. */
  description: string;
  /** Detailed usage text shown by `/command ?`. */
  usage?: string;
  /** When true, the command requires the sender to pass the allowFrom authorization check. */
  requireAuth?: boolean;
  /** When true, the command is only available in c2c (private) chat. Group invocations are rejected automatically. */
  c2cOnly?: boolean;
  /** Command handler. */
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

/** Framework command definition for commands that require authorization. */
export interface QQBotFrameworkCommand {
  name: string;
  description: string;
  usage?: string;
  c2cOnly?: boolean;
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

// ============ Command Registry ============

/** Lowercase and trim a string. */
function lc(s: string): string {
  return (s ?? "").toLowerCase().trim();
}

/**
 * Slash command registry.
 *
 * Maintains two maps:
 * - `commands` — QQBot message-flow commands
 * - `frameworkCommands` — auth-gated commands that are safe on the framework surface
 */
export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();
  private readonly frameworkCommands = new Map<string, SlashCommand>();

  /** Register one command. */
  register(cmd: SlashCommand): void {
    const key = lc(cmd.name);
    // Always register in the pre-dispatch map so QQ message-flow slash
    // commands can match and execute directly (with requireAuth gating).
    this.commands.set(key, cmd);
    // Auth-gated commands are exposed to the framework command surface.
    // Private-chat-only metadata is preserved so the bridge can enforce the
    // same routing restriction before dispatching handlers.
    if (cmd.requireAuth) {
      this.frameworkCommands.set(key, cmd);
    }
  }

  /** Return all commands that may be registered on the framework surface. */
  getFrameworkCommands(): QQBotFrameworkCommand[] {
    return Array.from(this.frameworkCommands.values()).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      usage: cmd.usage,
      c2cOnly: cmd.c2cOnly,
      handler: cmd.handler,
    }));
  }

  /** Return all pre-dispatch commands. */
  getPreDispatchCommands(): Map<string, SlashCommand> {
    return this.commands;
  }

  /** Return all registered commands (both maps) for help listing. */
  getAllCommands(): Map<string, SlashCommand> {
    const all = new Map<string, SlashCommand>();
    for (const [k, v] of this.commands) {
      all.set(k, v);
    }
    for (const [k, v] of this.frameworkCommands) {
      all.set(k, v);
    }
    return all;
  }

  /**
   * Try to match and execute a pre-dispatch slash command.
   *
   * @returns A reply when matched, or null when the message should continue
   *          through normal routing.
   */
  async matchSlashCommand(
    ctx: SlashCommandContext,
    log?: { info?: (msg: string) => void },
  ): Promise<SlashCommandResult> {
    const content = ctx.rawContent.trim();
    if (!content.startsWith("/")) {
      return null;
    }

    const spaceIdx = content.indexOf(" ");
    const cmdName = lc(spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx));
    const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

    const cmd = this.commands.get(cmdName);
    if (!cmd) {
      return null;
    }

    // Reject c2cOnly commands when invoked outside private chat.
    if (cmd.c2cOnly && ctx.type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    // Gate sensitive commands behind the allowFrom authorization check.
    if (cmd.requireAuth && !ctx.commandAuthorized) {
      log?.info?.(
        `[qqbot] Slash command /${cmd.name} rejected: sender ${ctx.senderId} is not authorized`,
      );
      const isGroup = ctx.type === "group" || ctx.type === "guild";
      const configHint = isGroup ? "groupAllowFrom" : "allowFrom";
      return `⛔ 权限不足：请先在 channels.qqbot.${configHint} 中配置明确的发送者列表后再使用 /${cmd.name}。`;
    }

    // `/command ?` returns usage help.
    if (args === "?") {
      if (cmd.usage) {
        return `📖 /${cmd.name} 用法：\n\n${cmd.usage}`;
      }
      return `/${cmd.name} - ${cmd.description}`;
    }

    ctx.args = args;
    return await cmd.handler(ctx);
  }
}
