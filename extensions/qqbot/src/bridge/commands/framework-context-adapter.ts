/**
 * Adapter that builds a `SlashCommandContext` from a framework
 * `PluginCommandContext`.
 *
 * Framework-registered commands enter the plugin through
 * `api.registerCommand`, which surfaces a `PluginCommandContext` shape. Our
 * engine-side command registry, however, is driven by `SlashCommandContext`.
 * This adapter bridges the two so handlers authored against the engine
 * registry can be reused unchanged on the framework command surface.
 */

import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SlashCommandContext } from "../../engine/commands/slash-commands.js";
import type { ResolvedQQBotAccount } from "../../types.js";
import type { QQBotFromParseResult } from "./from-parser.js";

/**
 * Default queue snapshot used for framework-registered commands.
 *
 * Framework-side command dispatch runs outside the per-sender queue, so
 * handlers observe an empty snapshot by design.
 */
const DEFAULT_QUEUE_SNAPSHOT = {
  totalPending: 0,
  activeUsers: 0,
  maxConcurrentUsers: 10,
  senderPending: 0,
} as const;

export interface BuildFrameworkSlashContextInput {
  ctx: PluginCommandContext;
  account: ResolvedQQBotAccount;
  from: QQBotFromParseResult;
  commandName: string;
}

export function buildFrameworkSlashContext({
  ctx,
  account,
  from,
  commandName,
}: BuildFrameworkSlashContextInput): SlashCommandContext {
  const args = ctx.args ?? "";
  const rawContent = args ? `/${commandName} ${args}` : `/${commandName}`;

  return {
    type: from.msgType,
    senderId: ctx.senderId ?? "",
    messageId: "",
    eventTimestamp: new Date().toISOString(),
    receivedAt: Date.now(),
    rawContent,
    args,
    accountId: account.accountId,
    appId: account.appId,
    accountConfig: account.config as unknown as Record<string, unknown>,
    commandAuthorized: true,
    queueSnapshot: { ...DEFAULT_QUEUE_SNAPSHOT },
  };
}
