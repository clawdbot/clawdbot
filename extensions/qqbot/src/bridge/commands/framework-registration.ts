/**
 * Register all `requireAuth: true` slash commands with the framework via
 * `api.registerCommand`.
 *
 * Routing through the framework lets `resolveCommandAuthorization()` apply
 * `commands.allowFrom.qqbot` precedence and the `qqbot:` prefix normalization
 * before any QQBot command handler runs.
 *
 * This module is intentionally thin: it wires the engine-side command
 * registry (`getFrameworkCommands`) to the framework registration surface via
 * the three single-responsibility helpers in this directory.
 */

import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { getFrameworkCommands } from "../../engine/commands/slash-commands-impl.js";
import { resolveQQBotAccount } from "../config.js";
import { buildFrameworkSlashContext } from "./framework-context-adapter.js";
import { parseQQBotFrom } from "./from-parser.js";
import { dispatchFrameworkSlashResult } from "./result-dispatcher.js";

export function registerQQBotFrameworkCommands(api: OpenClawPluginApi): void {
  for (const cmd of getFrameworkCommands()) {
    api.registerCommand({
      name: cmd.name,
      description: cmd.description,
      requireAuth: true,
      acceptsArgs: true,
      handler: async (ctx: PluginCommandContext) => {
        const from = parseQQBotFrom(ctx.from);
        const account = resolveQQBotAccount(ctx.config, ctx.accountId ?? undefined);
        const slashCtx = buildFrameworkSlashContext({
          ctx,
          account,
          from,
          commandName: cmd.name,
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
