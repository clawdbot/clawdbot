import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { RemindSchema, executeRemind } from "../../engine/tools/remind-logic.js";
import type { RemindParams } from "../../engine/tools/remind-logic.js";
import { getRequestContext } from "../../engine/utils/request-context.js";

export function registerRemindTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "qqbot_remind",
      label: "QQBot Reminder",
      description:
        "Create, list, and remove QQ reminders. " +
        "Use simple parameters without manually building cron JSON.\n" +
        "Create: action=add, content=message, time=schedule (to is optional, " +
        "resolved automatically from the current conversation)\n" +
        "List: action=list\n" +
        "Remove: action=remove, jobId=job id from list\n" +
        'Time examples: "5m", "1h", "0 8 * * *"',
      parameters: RemindSchema,
      async execute(_toolCallId, params) {
        const ctx = getRequestContext();
        return executeRemind(params as RemindParams, {
          fallbackTo: ctx?.target,
          fallbackAccountId: ctx?.accountId,
        });
      },
    },
    { name: "qqbot_remind" },
  );
}
