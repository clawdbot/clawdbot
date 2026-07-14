import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { matchPluginCommand } from "../../plugins/commands.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import {
  findCommandByNativeName,
  normalizeCommandBody,
  resolveTextCommand,
} from "../commands-registry.js";
import type { FinalizedMsgContext } from "../templating.js";
import { isExplicitSourceReplyCommand } from "./source-reply-delivery-mode.js";

export function shouldBypassPluginOwnedBindingForCommand(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const commandTurn = resolveCommandTurnContext(ctx);
  if (
    (commandTurn.kind === "native" || commandTurn.kind === "text-slash") &&
    !commandTurn.authorized
  ) {
    return false;
  }
  if (isNativeCommandTurn(commandTurn) && commandTurn.authorized) {
    return true;
  }
  if (!isExplicitSourceReplyCommand(ctx, cfg)) {
    return false;
  }
  const commandBody = normalizeCommandBody(commandTurn.body ?? ctx.CommandBody ?? "", {
    botUsername: ctx.BotUsername,
  });
  if (!commandBody.startsWith("/")) {
    return false;
  }
  if (resolveTextCommand(commandBody)) {
    return true;
  }
  const provider = normalizeOptionalString(ctx.Provider ?? ctx.Surface);
  if (
    commandTurn.commandName &&
    findCommandByNativeName(commandTurn.commandName, provider, {
      includeBundledChannelFallback: true,
    })
  ) {
    return true;
  }
  return Boolean(
    matchPluginCommand(commandBody, {
      channel: normalizeOptionalString(ctx.Surface ?? ctx.Provider),
    }),
  );
}
