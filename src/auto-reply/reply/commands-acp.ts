import { logVerbose } from "../../globals.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
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

const lifecycleHandlersLoader = createLazyImportLoader(() => import("./commands-acp/lifecycle.js"));
const runtimeOptionHandlersLoader = createLazyImportLoader(
  () => import("./commands-acp/runtime-options.js"),
);
const diagnosticHandlersLoader = createLazyImportLoader(
  () => import("./commands-acp/diagnostics.js"),
);

async function loadAcpActionHandler(action: Exclude<AcpAction, "help">): Promise<AcpActionHandler> {
  if (action === "spawn" || action === "cancel" || action === "steer" || action === "close") {
    const handlers = await lifecycleHandlersLoader.load();
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
    const handlers = await runtimeOptionHandlersLoader.load();
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

  const handlers = await diagnosticHandlersLoader.load();
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

export const handleAcpCommand: CommandHandler = async (params, _allowTextCommands) => {
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
