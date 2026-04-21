import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { jsonToolResult as json } from "./result.js";

interface RemindParams {
  action: "add" | "list" | "remove";
  content?: string;
  to?: string;
  time?: string;
  timezone?: string;
  name?: string;
  jobId?: string;
}

const RemindSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "Action type. add=create a reminder, list=show reminders, remove=delete a reminder.",
      enum: ["add", "list", "remove"],
    },
    content: {
      type: "string",
      description:
        'Reminder content, for example "drink water" or "join the meeting". Required when action=add.',
    },
    to: {
      type: "string",
      description:
        "Delivery target from the `[QQBot] to=` context value. " +
        "Direct-message format: qqbot:c2c:user_openid. Group format: qqbot:group:group_openid. Required when action=add.",
    },
    time: {
      type: "string",
      description:
        "Time description. Supported formats:\n" +
        '1. Relative time, for example "5m", "1h", "1h30m", or "2d"\n' +
        '2. Cron expression, for example "0 8 * * *" or "0 9 * * 1-5"\n' +
        "Values containing spaces are treated as cron expressions; everything else is treated as a one-shot relative delay.\n" +
        "Required when action=add.",
    },
    timezone: {
      type: "string",
      description: 'Timezone used for cron reminders. Defaults to "Asia/Shanghai".',
    },
    name: {
      type: "string",
      description: "Optional reminder job name. Defaults to the first 20 characters of content.",
    },
    jobId: {
      type: "string",
      description: "Job ID to remove. Required when action=remove; fetch it with list first.",
    },
  },
  required: ["action"],
} as const;

function parseRelativeTime(timeStr: string): number | null {
  const s = normalizeLowercaseStringOrEmpty(timeStr);
  if (/^\d+$/.test(s)) {
    return parseInt(s, 10) * 60_000;
  }

  let totalMs = 0;
  let matched = false;
  const regex = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(s)) !== null) {
    matched = true;
    const value = parseFloat(match[1]);
    const unit = match[2];
    switch (unit) {
      case "d":
        totalMs += value * 86_400_000;
        break;
      case "h":
        totalMs += value * 3_600_000;
        break;
      case "m":
        totalMs += value * 60_000;
        break;
      case "s":
        totalMs += value * 1_000;
        break;
    }
  }
  return matched ? Math.round(totalMs) : null;
}

function isCronExpression(timeStr: string): boolean {
  const parts = timeStr.trim().split(/\s+/);
  if (parts.length < 3 || parts.length > 6) {
    return false;
  }
  // Each cron field must start with a digit, *, or a cron-special character.
  return parts.every((p) => /^[0-9*?/,LW#-]/.test(p));
}

function generateJobName(content: string): string {
  const trimmed = content.trim();
  const short = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
  return `Reminder: ${short}`;
}

function buildReminderPrompt(content: string): string {
  return (
    `You are a warm reminder assistant. Please remind the user about: ${content}. ` +
    `Requirements: (1) do not reply with HEARTBEAT_OK (2) do not explain who you are ` +
    `(3) output a direct and caring reminder message (4) you may add a short encouraging line ` +
    `(5) keep it within 2-3 sentences (6) use a small amount of emoji.`
  );
}

function buildOnceJob(params: RemindParams, delayMs: number) {
  const atMs = Date.now() + delayMs;
  const to = params.to!;
  const content = params.content!;
  const name = params.name || generateJobName(content);
  return {
    action: "add",
    job: {
      name,
      schedule: { kind: "at", atMs },
      sessionTarget: "isolated",
      wakeMode: "now",
      deleteAfterRun: true,
      payload: {
        kind: "agentTurn",
        message: buildReminderPrompt(content),
        deliver: true,
        channel: "qqbot",
        to,
      },
    },
  };
}

function buildCronJob(params: RemindParams) {
  const to = params.to!;
  const content = params.content!;
  const name = params.name || generateJobName(content);
  const tz = params.timezone || "Asia/Shanghai";
  return {
    action: "add",
    job: {
      name,
      schedule: { kind: "cron", expr: params.time!.trim(), tz },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: buildReminderPrompt(content),
        deliver: true,
        channel: "qqbot",
        to,
      },
    },
  };
}

function formatDelay(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h${minutes}m`;
}

export function registerRemindTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "qqbot_remind",
      label: "QQBot Reminder",
      description:
        "Create, list, and remove QQ reminders. " +
        "Use simple parameters without manually building cron JSON.\n" +
        "Create: action=add, content=message, to=target, time=schedule\n" +
        "List: action=list\n" +
        "Remove: action=remove, jobId=job id from list\n" +
        'Time examples: "5m", "1h", "0 8 * * *"',
      parameters: RemindSchema,
      async execute(_toolCallId, params) {
        const p = params as RemindParams;

        if (p.action === "list") {
          return json({
            _instruction: "Use the cron tool immediately with the following parameters.",
            cronParams: { action: "list" },
          });
        }

        if (p.action === "remove") {
          if (!p.jobId) {
            return json({
              error: "jobId is required when action=remove. Use action=list first.",
            });
          }
          return json({
            _instruction: "Use the cron tool immediately with the following parameters.",
            cronParams: { action: "remove", jobId: p.jobId },
          });
        }

        if (!p.content) {
          return json({ error: "content is required when action=add" });
        }
        if (!p.to) {
          return json({ error: "to is required when action=add" });
        }
        if (!p.time) {
          return json({ error: "time is required when action=add" });
        }

        if (isCronExpression(p.time)) {
          return json({
            _instruction:
              "Use the cron tool immediately with the following parameters, then tell the user the reminder has been scheduled.",
            cronParams: buildCronJob(p),
            summary: `⏰ Recurring reminder: "${p.content}" (${p.time}, tz=${p.timezone || "Asia/Shanghai"})`,
          });
        }

        const delayMs = parseRelativeTime(p.time);
        if (delayMs == null) {
          return json({
            error: `Could not parse time format: ${p.time}. Use values like 5m, 1h, 1h30m, or a cron expression.`,
          });
        }
        if (delayMs < 30_000) {
          return json({ error: "Reminder delay must be at least 30 seconds" });
        }

        return json({
          _instruction:
            "Use the cron tool immediately with the following parameters, then tell the user the reminder has been scheduled.",
          cronParams: buildOnceJob(p, delayMs),
          summary: `⏰ Reminder in ${formatDelay(delayMs)}: "${p.content}"`,
        });
      },
    },
    { name: "qqbot_remind" },
  );
}
