import {
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
} from "../../agents/tools/in-process-gateway.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import {
  DEFAULT_UPDATE_TIMEOUT_MS,
  summarizeUpdateRunResponse,
} from "../../gateway/update-run-summary.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { commandReply, rejectNonOwnerCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleUpdateCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands || params.command.commandBodyNormalized !== "/update") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /update from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const nonOwner = rejectNonOwnerCommand(params, "/update");
  if (nonOwner) {
    return nonOwner;
  }
  if (!isRestartEnabled(params.cfg)) {
    return commandReply("⚠️ /update is disabled (commands.restart=false).");
  }
  // Like /restart, the update can tear down this process before dispatch returns.
  // Adopt first so the successor cannot replay this non-idempotent command;
  // adoption loss must abort the update because another owner holds the event.
  await params.opts?.turnAdoptionLifecycle?.onAdopted();
  try {
    const response = await callInProcessGatewayTool(
      "update.run",
      { sessionKey: params.sessionKey, note: "/update", timeoutMs: DEFAULT_UPDATE_TIMEOUT_MS },
      {
        resolveGatewayContext:
          readChannelContextGatewayContextResolver(params.ctx) ?? getInProcessGatewayToolContext,
        timeoutMs: DEFAULT_UPDATE_TIMEOUT_MS,
      },
    );
    const summary = summarizeUpdateRunResponse(response);
    if (summary.ok) {
      const versions =
        summary.before && summary.after
          ? ` (${summary.before.version} → ${summary.after.version})`
          : "";
      return commandReply(
        `⬆️ Updating OpenClaw${versions}. Back in a few minutes; I'll confirm here.`,
      );
    }
    const message = summary.handoff?.message?.replaceAll("\n", " ");
    const command = summary.handoff?.command;
    const manualCommand = command && !message?.includes(command) ? `Run manually: ${command}` : "";
    return commandReply(
      [`⚠️ Update did not start: ${summary.reason ?? summary.status}.`, message, manualCommand]
        .filter(Boolean)
        .join(" "),
    );
  } catch (err) {
    return commandReply(`⚠️ Update request failed: ${formatErrorMessage(err)}`);
  }
};
