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
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
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
      const run = summary.runId ? getUpdateRun(summary.runId) : undefined;
      if (!run) {
        throw new Error(
          summary.message ??
            summary.reason ??
            "Update run unavailable; run openclaw update status to inspect the outcome.",
        );
      }
      const command = summary.handoff?.command;
      const message = summary.message ?? summary.handoff?.message;
      const nextAction = summary.ok
        ? undefined
        : [message, command && !message?.includes(command) ? `Run manually: ${command}` : undefined]
            .filter(Boolean)
            .join("\n");
      return commandReply(renderUpdateRunReport(run, nextAction ? { nextAction } : {}).markdown);
    } catch (err) {
      return commandReply(`⚠️ Update request failed: ${formatErrorMessage(err)}`);
    }
  },
);
