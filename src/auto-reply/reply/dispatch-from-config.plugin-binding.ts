import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { matchPluginCommand } from "../../plugins/commands.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import {
  findCommandByNativeName,
  normalizeCommandBody,
  resolveTextCommand,
} from "../commands-registry.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveCommandContextText } from "./context-text.js";
import { isExplicitSourceReplyCommand } from "./source-reply-delivery-mode.js";

export function shouldBypassPluginOwnedBindingForCommand(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): boolean {
  // Command authorization is a trust boundary. Reject malformed runtime context
  // before command-turn normalization can coerce a truthy value.
  if (ctx.CommandAuthorized !== undefined && typeof ctx.CommandAuthorized !== "boolean") {
    return false;
  }
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
  const isAuthorizedTextCommand =
    (commandTurn.kind === "text-slash" && commandTurn.authorized) ||
    (commandTurn.kind === "normal" &&
      typeof ctx.CommandAuthorized === "boolean" &&
      ctx.CommandAuthorized);
  if (
    !isAuthorizedTextCommand ||
    !shouldHandleTextCommands({
      cfg,
      surface: ctx.Surface ?? ctx.Provider ?? "",
      commandSource: ctx.CommandSource,
    })
  ) {
    return false;
  }
  const commandBody = normalizeCommandBody(commandTurn.body ?? resolveCommandContextText(ctx), {
    botUsername: ctx.BotUsername,
  });
  if (!commandBody.startsWith("/")) {
    return false;
  }
  if (
    matchPluginCommand(commandBody, {
      channel: normalizeOptionalString(ctx.Surface ?? ctx.Provider),
    })
  ) {
    return true;
  }
  if (!isExplicitSourceReplyCommand(ctx, cfg)) {
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
  return false;
}
