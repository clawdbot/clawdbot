/**
 * QQBot reminder tool core logic.
 * QQBot 提醒工具核心逻辑。
 *
 * Pure functions for time parsing, cron detection, job building,
 * and remind execution. The framework registration shell
 * (bridge/tools/remind.ts) delegates all business logic here and
 * supplies request-level context fallbacks (`to`, `accountId`).
 */

/**
 * Reminder tool input parameters.
 * 提醒工具的输入参数。
 */
export interface RemindParams {
  action: "add" | "list" | "remove";
  content?: string;
  to?: string;
  time?: string;
  timezone?: string;
  name?: string;
  jobId?: string;
}

/**
 * Context supplied by the bridge layer so the engine can remain free of
 * framework / AsyncLocalStorage dependencies. `fallbackTo` and
 * `fallbackAccountId` are consulted only when the corresponding AI-supplied
 * parameter is missing.
 */
export interface RemindExecuteContext {
  fallbackTo?: string;
  fallbackAccountId?: string;
}

export type RemindCronAction =
  | { action: "list" }
  | { action: "remove"; jobId: string }
  | {
      action: "add";
      job: ReturnType<typeof buildOnceJob>["job"] | ReturnType<typeof buildCronJob>["job"];
    };

export type RemindCronScheduler = (params: RemindCronAction) => Promise<unknown>;

export type RemindCronPlan =
  | {
      ok: true;
      action: RemindParams["action"];
      cronAction: RemindCronAction;
      summary?: string;
    }
  | {
      ok: false;
      error: string;
    };

const PREPARED_CRON_PARAMS_INSTRUCTION =
  "Gateway cron action prepared for internal QQ reminder scheduling.";

/**
 * JSON Schema for AI tool parameters (used by framework registration).
 * AI Tool 参数的 JSON Schema 定义（供框架注册使用）。
 */
export const RemindSchema = {
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
        "Optional delivery target. The runtime automatically resolves the current " +
        "conversation target, so you usually do not need to supply this. " +
        "Direct-message format: qqbot:c2c:user_openid. Group format: qqbot:group:group_openid.",
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

/**
 * Parse a relative time string into milliseconds.
 * 解析相对时间字符串为毫秒数。
 *
 * Supports: "5m", "1h", "1h30m", "2d", "45s", plain number (as minutes).
 *
 * @returns Milliseconds or null if unparseable.
 */
export function parseRelativeTime(timeStr: string): number | null {
  const s = timeStr.toLowerCase();
  if (/^\d+$/.test(s)) {
    return Number.parseInt(s, 10) * 60_000;
  }

  let totalMs = 0;
  let matched = false;
  const regex = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(s)) !== null) {
    matched = true;
    const value = Number.parseFloat(match[1]);
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

/**
 * Check whether a time string is a cron expression (3–6 space-separated fields).
 * 判断时间字符串是否为 cron 表达式。
 */
export function isCronExpression(timeStr: string): boolean {
  const parts = timeStr.trim().split(/\s+/);
  if (parts.length < 3 || parts.length > 6) {
    return false;
  }
  return parts.every((p) => /^[0-9*?/,LW#-]/.test(p));
}

/**
 * Generate a cron job name from reminder content (first 20 chars).
 * 根据提醒内容生成 cron job 名称。
 */
export function generateJobName(content: string): string {
  const trimmed = content.trim();
  const short = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
  return `Reminder: ${short}`;
}

/** Build the reminder system prompt sent to the AI. */
export function buildReminderPrompt(content: string): string {
  return (
    `You are a warm reminder assistant. Please remind the user about: ${content}. ` +
    `Requirements: (1) do not reply with HEARTBEAT_OK (2) do not explain who you are ` +
    `(3) output a direct and caring reminder message (4) you may add a short encouraging line ` +
    `(5) keep it within 2-3 sentences (6) use a small amount of emoji.`
  );
}

/** Build cron job params for a one-shot delayed reminder. */
export function buildOnceJob(params: RemindParams, delayMs: number, to: string, accountId: string) {
  const atMs = Date.now() + delayMs;
  const content = params.content!;
  const name = params.name || generateJobName(content);
  return {
    action: "add" as const,
    job: {
      name,
      schedule: { kind: "at" as const, atMs },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      deleteAfterRun: true,
      payload: {
        kind: "agentTurn" as const,
        message: buildReminderPrompt(content),
      },
      delivery: {
        mode: "announce" as const,
        channel: "qqbot" as const,
        to,
        accountId,
      },
    },
  };
}

/** Build cron job params for a recurring cron reminder. */
export function buildCronJob(params: RemindParams, to: string, accountId: string) {
  const content = params.content!;
  const name = params.name || generateJobName(content);
  const tz = params.timezone || "Asia/Shanghai";
  return {
    action: "add" as const,
    job: {
      name,
      schedule: { kind: "cron" as const, expr: params.time!.trim(), tz },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: {
        kind: "agentTurn" as const,
        message: buildReminderPrompt(content),
      },
      delivery: {
        mode: "announce" as const,
        channel: "qqbot" as const,
        to,
        accountId,
      },
    },
  };
}

/** Format a delay in milliseconds as a short string (e.g. "5m", "1h30m"). */
export function formatDelay(ms: number): string {
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

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function formatSchedulerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function prepareRemindCronAction(
  params: RemindParams,
  ctx: RemindExecuteContext = {},
): RemindCronPlan {
  if (params.action === "list") {
    return { ok: true, action: "list", cronAction: { action: "list" } };
  }

  if (params.action === "remove") {
    if (!params.jobId) {
      return { ok: false, error: "jobId is required when action=remove. Use action=list first." };
    }
    return {
      ok: true,
      action: "remove",
      cronAction: { action: "remove", jobId: params.jobId },
    };
  }

  if (!params.content) {
    return { ok: false, error: "content is required when action=add" };
  }
  const resolvedTo = params.to || ctx.fallbackTo;
  if (!resolvedTo) {
    return {
      ok: false,
      error:
        "Unable to determine delivery target for action=add. " +
        "The reminder can only be scheduled from within an active conversation.",
    };
  }
  if (!params.time) {
    return { ok: false, error: "time is required when action=add" };
  }
  const resolvedAccountId = ctx.fallbackAccountId || "default";

  if (isCronExpression(params.time)) {
    return {
      ok: true,
      action: "add",
      cronAction: buildCronJob(params, resolvedTo, resolvedAccountId),
      summary: `⏰ Recurring reminder: "${params.content}" (${params.time}, tz=${params.timezone || "Asia/Shanghai"})`,
    };
  }

  const delayMs = parseRelativeTime(params.time);
  if (delayMs == null) {
    return {
      ok: false,
      error: `Could not parse time format: ${params.time}. Use values like 5m, 1h, 1h30m, or a cron expression.`,
    };
  }
  if (delayMs < 30_000) {
    return { ok: false, error: "Reminder delay must be at least 30 seconds" };
  }

  return {
    ok: true,
    action: "add",
    cronAction: buildOnceJob(params, delayMs, resolvedTo, resolvedAccountId),
    summary: `⏰ Reminder in ${formatDelay(delayMs)}: "${params.content}"`,
  };
}

/**
 * Execute the reminder tool logic.
 * 执行提醒工具逻辑。
 *
 * Validates params, parses time, and returns a structured result
 * containing cron job params that the framework shell passes back
 * as the tool output.
 *
 * When the AI omits `to` / `accountId`, the bridge layer can supply
 * `ctx.fallbackTo` / `ctx.fallbackAccountId` (typically resolved from
 * the request-scoped AsyncLocalStorage) to fill them in.
 */
export function executeRemind(params: RemindParams, ctx: RemindExecuteContext = {}) {
  const plan = prepareRemindCronAction(params, ctx);
  if (!plan.ok) {
    return json({ error: plan.error });
  }
  return json({
    _instruction: PREPARED_CRON_PARAMS_INSTRUCTION,
    action: plan.action,
    summary: plan.summary,
  });
}

export async function executeScheduledRemind(
  params: RemindParams,
  ctx: RemindExecuteContext,
  scheduler: RemindCronScheduler,
) {
  const plan = prepareRemindCronAction(params, ctx);
  if (!plan.ok) {
    return json({ error: plan.error });
  }

  try {
    const cronResult = await scheduler(plan.cronAction);
    return json({
      ok: true,
      action: plan.action,
      summary: plan.summary,
      cronResult,
    });
  } catch (error) {
    return json({
      error: `Failed to run Gateway cron action: ${formatSchedulerError(error)}`,
      action: plan.action,
    });
  }
}
