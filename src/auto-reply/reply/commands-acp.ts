import { logVerbose } from "../../globals.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import {
  COMMAND,
  type AcpAction,
  resolveAcpAction,
  resolveAcpHelpText,
  stopWithText,
} from "./commands-acp/shared.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

type AcpActionHandler = (
  params: HandleCommandsParams,
  tokens: string[],
) => Promise<CommandHandlerResult>;

let lifecycleHandlersPromise: Promise<typeof import("./commands-acp/lifecycle.js")> | undefined;
let runtimeOptionHandlersPromise:
  | Promise<typeof import("./commands-acp/runtime-options.js")>
  | undefined;
let diagnosticHandlersPromise: Promise<typeof import("./commands-acp/diagnostics.js")> | undefined;

async function loadAcpActionHandler(action: Exclude<AcpAction, "help">): Promise<AcpActionHandler> {
  if (action === "spawn" || action === "cancel" || action === "steer" || action === "close") {
    lifecycleHandlersPromise ??= import("./commands-acp/lifecycle.js");
    const handlers = await lifecycleHandlersPromise;
    return {
      spawn: handlers.handleAcpSpawnAction,
      cancel: handlers.handleAcpCancelAction,
      steer: handlers.handleAcpSteerAction,
      close: handlers.handleAcpCloseAction,
    }[action];
  }

  if (
    action === "status" ||
    action === "set-mode" ||
    action === "set" ||
    action === "cwd" ||
    action === "permissions" ||
    action === "timeout" ||
    action === "model" ||
    action === "reset-options"
  ) {
    runtimeOptionHandlersPromise ??= import("./commands-acp/runtime-options.js");
    const handlers = await runtimeOptionHandlersPromise;
    return {
      status: handlers.handleAcpStatusAction,
      "set-mode": handlers.handleAcpSetModeAction,
      set: handlers.handleAcpSetAction,
      cwd: handlers.handleAcpCwdAction,
      permissions: handlers.handleAcpPermissionsAction,
      timeout: handlers.handleAcpTimeoutAction,
      model: handlers.handleAcpModelAction,
      "reset-options": handlers.handleAcpResetOptionsAction,
    }[action];
  }

  diagnosticHandlersPromise ??= import("./commands-acp/diagnostics.js");
  const handlers = await diagnosticHandlersPromise;
  const diagnosticHandlers: Record<"doctor" | "install" | "sessions", AcpActionHandler> = {
    doctor: handlers.handleAcpDoctorAction,
    install: async (params, tokens) => handlers.handleAcpInstallAction(params, tokens),
    sessions: async (params, tokens) => handlers.handleAcpSessionsAction(params, tokens),
  };
  return diagnosticHandlers[action];
}

const ACP_MUTATING_ACTIONS = new Set<AcpAction>([
  "spawn",
  "cancel",
  "steer",
  "close",
  "status",
  "set-mode",
  "set",
  "cwd",
  "permissions",
  "timeout",
  "model",
  "reset-options",
]);

export const handleAcpCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;
  if (!normalized.startsWith(COMMAND)) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /acp from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  const rest = normalized.slice(COMMAND.length).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = resolveAcpAction(tokens);
  if (action === "help") {
    return stopWithText(resolveAcpHelpText());
  }

  if (ACP_MUTATING_ACTIONS.has(action)) {
    const scopeBlock = requireGatewayClientScopeForInternalChannel(params, {
      label: "/acp",
      allowedScopes: ["operator.admin"],
      missingText: "This /acp action requires operator.admin on the internal channel.",
    });
    if (scopeBlock) {
      return scopeBlock;
    }
  }

  const handler = await loadAcpActionHandler(action);
  return await handler(params, tokens);
};
