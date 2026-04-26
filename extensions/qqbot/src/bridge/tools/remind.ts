import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { RemindSchema, executeScheduledRemind } from "../../engine/tools/remind-logic.js";
import type { RemindCronAction, RemindParams } from "../../engine/tools/remind-logic.js";
import { getRequestContext } from "../../engine/utils/request-context.js";

type CronGatewayCaller = (params: RemindCronAction) => Promise<unknown>;

type RemindToolDeps = {
  callCron: CronGatewayCaller;
};

const DEFAULT_GATEWAY_TIMEOUT_MS = 60_000;

function unexpectedCronParams(params: never): never {
  throw new Error(`Unsupported reminder cron action: ${JSON.stringify(params)}`);
}

const defaultDeps: RemindToolDeps = {
  callCron: async (params) => {
    switch (params.action) {
      case "list":
        return await callGatewayTool("cron.list", { timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS }, {});
      case "remove":
        return await callGatewayTool(
          "cron.remove",
          { timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS },
          { jobId: params.jobId },
        );
      case "add":
        return await callGatewayTool(
          "cron.add",
          { timeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS },
          { job: params.job },
        );
    }
    return unexpectedCronParams(params);
  },
};

export function createRemindTool(
  toolContext: OpenClawPluginToolContext = {},
  deps: RemindToolDeps = defaultDeps,
): AnyAgentTool {
  return {
    name: "qqbot_remind",
    label: "QQBot Reminder",
    ownerOnly: true,
    description:
      "Create, list, and remove QQ reminders. " +
      "This tool schedules Gateway cron jobs directly; do not call the cron tool after it succeeds.\n" +
      "Create: action=add, content=message, time=schedule (to is optional, " +
      "resolved automatically from the current conversation)\n" +
      "List: action=list\n" +
      "Remove: action=remove, jobId=job id from list\n" +
      'Time examples: "5m", "1h", "0 8 * * *"',
    parameters: RemindSchema,
    async execute(_toolCallId, params) {
      if (toolContext.senderIsOwner !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "QQ reminders require an owner-authorized sender.",
              }),
            },
          ],
          details: { error: "QQ reminders require an owner-authorized sender." },
        };
      }
      const ctx = getRequestContext();
      return await executeScheduledRemind(
        params as RemindParams,
        {
          fallbackTo: ctx?.target ?? toolContext.deliveryContext?.to,
          fallbackAccountId: ctx?.accountId ?? toolContext.deliveryContext?.accountId,
        },
        deps.callCron,
      );
    },
  };
}

export function registerRemindTool(api: OpenClawPluginApi): void {
  api.registerTool((ctx) => createRemindTool(ctx), { name: "qqbot_remind" });
}
