import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createPluginCommandRuntime,
  matchPluginCommandInvocation,
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandCatalogDecision,
  type PluginCommandExecutionReplyOptions,
} from "../../plugins/plugin-command-runtime.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import {
  findCommandByNativeName,
  normalizeCommandBody,
  resolveTextCommand,
} from "../commands-registry.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { resolveCommandContextText } from "./context-text.js";
import { isExplicitSourceReplyCommand } from "./source-reply-delivery-mode.js";

export function shouldBypassPluginOwnedBindingForCommand(
  ctx: FinalizedRuntimeMsgContext,
  cfg: OpenClawConfig,
  replyOptions?: PluginCommandExecutionReplyOptions,
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
  const planned = replyOptions?.[PLUGIN_COMMAND_DISPATCH];
  if (planned) {
    return true;
  }
  const channel = normalizeOptionalString(ctx.Surface ?? ctx.Provider) ?? "";
  const match = matchPluginCommandInvocation(createPluginCommandRuntime(), commandBody, {
    channel,
  });
  if (match) {
    if (replyOptions) {
      (replyOptions as { [PLUGIN_COMMAND_DISPATCH]?: PluginCommandCatalogDecision })[
        PLUGIN_COMMAND_DISPATCH
      ] = match.dispatch;
    }
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
