// Applies command feature gates before command handlers execute.
import { formatCommandOwnerHint } from "../../commands/doctor-command-owner.js";
import {
  isCommandFlagEnabled,
  isRestartEnabled,
  type CommandFlagKey,
} from "../../config/commands.flags.js";
import { logVerbose } from "../../globals.js";
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { ReplyPayload } from "../types.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

/** Builds the standard terminal text response shared by chat command handlers. */
export function commandReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

/** Returns command arguments only when the complete slash-command token matches. */
export function matchCommandPrefix(body: string, command: string): string | null {
  return body === command
    ? ""
    : body.startsWith(`${command} `)
      ? body.slice(command.length).trim()
      : null;
}

/** Keeps matching, text-command enablement, and sender authorization in one owner. */
export function defineAuthorizedTextCommand<T>(
  options: {
    label: string;
    match: (body: string, params: HandleCommandsParams) => T | null;
    ownerOnly?: boolean | ((params: HandleCommandsParams, match: T) => boolean);
    silentUnauthorized?: boolean;
  },
  run: (
    params: HandleCommandsParams,
    match: T,
  ) => Promise<CommandHandlerResult | null> | CommandHandlerResult | null,
): CommandHandler {
  return async (params, allowTextCommands) => {
    if (!allowTextCommands) {
      return null;
    }
    const match = options.match(params.command.commandBodyNormalized, params);
    if (match === null) {
      return null;
    }
    const unauthorized = rejectUnauthorizedCommand(params, options.label);
    if (unauthorized) {
      return options.silentUnauthorized ? { shouldContinue: false } : unauthorized;
    }
    const ownerOnly =
      typeof options.ownerOnly === "function"
        ? options.ownerOnly(params, match)
        : options.ownerOnly;
    return ownerOnly
      ? (rejectNonOwnerCommand(params, options.label) ?? run(params, match))
      : run(params, match);
  };
}

export function defineGatewayControlCommand(
  label: "/restart" | "/update",
  run: (params: HandleCommandsParams) => ReturnType<CommandHandler>,
): CommandHandler {
  return defineAuthorizedTextCommand(
    {
      label,
      match: (body) => (body === label ? true : null),
      ownerOnly: true,
      silentUnauthorized: true,
    },
    async (params) => {
      if (!isRestartEnabled(params.cfg)) {
        return commandReply(`⚠️ ${label} is disabled (commands.restart=false).`);
      }
      // Adopt before teardown so the successor cannot replay this non-idempotent
      // command. Adoption loss throws and must prevent the effect.
      await params.opts?.turnAdoptionLifecycle?.onAdopted();
      return run(params);
    },
  );
}

export function rejectUnauthorizedCommand(
  params: HandleCommandsParams,
  commandLabel: string,
): CommandHandlerResult | null {
  if (params.command.isAuthorizedSender) {
    return null;
  }
  logVerbose(
    `Ignoring ${commandLabel} from unauthorized sender: ${redactIdentifier(params.command.senderId)}`,
  );
  if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) {
    return commandReply("You are not authorized to use this command.");
  }
  return { shouldContinue: false };
}

export function rejectNonOwnerCommand(
  params: HandleCommandsParams,
  commandLabel: string,
): CommandHandlerResult | null {
  if (params.command.senderIsOwner) {
    return null;
  }
  logVerbose(
    `Ignoring ${commandLabel} from non-owner sender: ${redactIdentifier(params.command.senderId)}`,
  );
  if (!params.command.isAuthorizedSender) {
    return rejectUnauthorizedCommand(params, commandLabel);
  }
  const hint = formatCommandOwnerHint({
    cfg: params.cfg,
    channel: params.command.channel,
    id: params.command.senderId,
  });
  return commandReply(`You are not authorized to use this owner-only command. ${hint}`);
}

export function requireGatewayClientScope(
  params: Pick<HandleCommandsParams, "ctx">,
  config: {
    label: string;
    allowedScopes: string[];
    missingText: string;
  },
): CommandHandlerResult | null {
  const scopes = params.ctx.GatewayClientScopes;
  if (!Array.isArray(scopes)) {
    return null;
  }
  if (config.allowedScopes.some((scope) => scopes.includes(scope))) {
    return null;
  }
  logVerbose(
    `Ignoring ${config.label} from gateway client missing scope: ${config.allowedScopes.join(" or ")}`,
  );
  return commandReply(config.missingText);
}

export function buildDisabledCommandReply(params: {
  label: string;
  configKey: CommandFlagKey;
  disabledVerb?: "is" | "are";
  docsUrl?: string;
}): ReplyPayload {
  const disabledVerb = params.disabledVerb ?? "is";
  const docsSuffix = params.docsUrl ? ` Docs: ${params.docsUrl}` : "";
  return {
    text: `⚠️ ${params.label} ${disabledVerb} disabled. Set commands.${params.configKey}=true to enable.${docsSuffix}`,
  };
}

export function requireCommandFlagEnabled(
  cfg: { commands?: unknown } | undefined,
  params: {
    label: string;
    configKey: CommandFlagKey;
    disabledVerb?: "is" | "are";
    docsUrl?: string;
  },
): CommandHandlerResult | null {
  if (isCommandFlagEnabled(cfg, params.configKey)) {
    return null;
  }
  return {
    shouldContinue: false,
    reply: buildDisabledCommandReply(params),
  };
}
