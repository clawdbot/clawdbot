import {
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
} from "../../agents/tools/in-process-gateway.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import {
  DEFAULT_UPDATE_TIMEOUT_MS,
  summarizeUpdateRunResponse,
} from "../../gateway/update-run-summary.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { commandReply, defineGatewayControlCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleUpdateCommand: CommandHandler = defineGatewayControlCommand(
  "/update",
  async (params) => {
    try {
      const response = await callInProcessGatewayTool(
        "update.run",
        {
          sessionKey: params.sessionKey,
          note: "/update",
          timeoutMs: DEFAULT_UPDATE_TIMEOUT_MS,
          requester: {
            channel: params.command.channel ?? params.ctx.Provider,
            accountId: params.ctx.AccountId,
            senderId: params.command.senderId,
          },
        },
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
      const message = (summary.message ?? summary.handoff?.message)?.replaceAll("\n", " ");
      const command = summary.handoff?.command;
      const manualCommand =
        command && !message?.includes(command) ? `Run manually: ${command}` : "";
      return commandReply(
        [`⚠️ Update did not start: ${summary.reason ?? summary.status}.`, message, manualCommand]
          .filter(Boolean)
          .join(" "),
      );
    } catch (err) {
      return commandReply(`⚠️ Update request failed: ${formatErrorMessage(err)}`);
    }
  },
);
