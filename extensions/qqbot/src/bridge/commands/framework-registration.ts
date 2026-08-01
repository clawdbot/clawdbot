/**
 * Register slash commands that are allowed on the framework surface via
 * `api.registerCommand`.
 *
 * Routing through the framework lets `resolveCommandAuthorization()` apply
 * `commands.allowFrom.qqbot` precedence and the `qqbot:` prefix normalization
 * before any QQBot command handler runs.
 *
 * This module is intentionally thin: it wires the engine-side command registry
 * (`getFrameworkCommands`) to the framework registration surface via the three
 * single-responsibility helpers in this directory.
 */

import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { PRIVATE_CHAT_ONLY_TEXT } from "../../engine/commands/command-visibility.js";
import { getFrameworkCommands } from "../../engine/commands/slash-commands-impl.js";
import { resolveGroupCommandLevelFromAccountConfig } from "../../engine/config/group.js";
import { resolveQQBotAccount } from "../config.js";
import { buildFrameworkSlashContext } from "./framework-context-adapter.js";
import { parseQQBotFrom } from "./from-parser.js";
import { dispatchFrameworkSlashResult } from "./result-dispatcher.js";

function isExplicitQQBotC2cFrom(from: string | undefined | null): boolean {
  const raw = (from ?? "").trim();
  const stripped = raw.replace(/^qqbot:/iu, "");
  const colonIdx = stripped.indexOf(":");
  if (colonIdx === -1) {
    return false;
  }
  const kind = stripped.slice(0, colonIdx).toLowerCase();
  const targetId = stripped.slice(colonIdx + 1).trim();
  return /^qqbot:/iu.test(raw) && kind === "c2c" && targetId.length > 0;
}

export function registerQQBotFrameworkCommands(api: OpenClawPluginApi): void {
  for (const cmd of getFrameworkCommands()) {
    api.registerCommand({
      name: cmd.name,
      description: cmd.description,
      channels: ["qqbot"],
      requireAuth: true,
      acceptsArgs: true,
      handler: async (ctx: PluginCommandContext) => {
        const from = parseQQBotFrom(ctx.from);
        const account = resolveQQBotAccount(ctx.config, ctx.accountId ?? undefined);
        const groupCommandLevel =
          from.msgType === "group" || from.msgType === "guild"
            ? resolveGroupCommandLevelFromAccountConfig(
                account.config as unknown as Record<string, unknown>,
                from.targetId,
              )
            : undefined;
        if (cmd.c2cOnly && !isExplicitQQBotC2cFrom(ctx.from)) {
          return { text: PRIVATE_CHAT_ONLY_TEXT };
        }

        const slashCtx = buildFrameworkSlashContext({
          ctx,
          account,
          from,
          commandName: cmd.name,
          groupCommandLevel,
        });
        const result = await cmd.handler(slashCtx);
        return await dispatchFrameworkSlashResult({
          result,
          account,
          from,
          logger: api.logger,
        });
      },
    });
  }
}
