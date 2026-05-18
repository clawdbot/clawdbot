import { Type, type TSchema } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveCronCreationDelivery } from "../../cron/delivery-context.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { isRecord, truncateUtf16Safe } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { CRON_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

// We spell out job/patch properties so that LLMs know what fields to send.
// Nested unions are avoided; runtime validation happens in normalizeCronJob*.

const CRON_ACTIONS = [
  "status",
  "list",
  "get",
  "add",
  "update",
  "remove",
  "run",
  "runs",
  "wake",
] as const;

const CRON_SCHEDULE_KINDS = ["at", "every", "cron"] as const;
const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn"] as const;
const CRON_DELIVERY_MODES = ["none", "announce", "webhook"] as const;
const CRON_RUN_MODES = ["due", "force"] as const;
const CRON_FLAT_PAYLOAD_KEYS = [
  "message",
  "text",
  "model",
  "fallbacks",
  "toolsAllow",
  "thinking",
  "timeoutSeconds",
  "lightContext",
  "allowUnsafeExternalContent",
] as const;
const CRON_FLAT_SCHEDULE_KEYS = [
  "kind",
  "at",
  "atMs",
  "every",
  "everyMs",
  "anchorMs",
  "cron",
  "expr",
  "tz",
  "stagger",
  "staggerMs",
  "exact",
] as const;
const CRON_RECOVERABLE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "schedule",
  "sessionTarget",
  "wakeMode",
  "payload",
  "delivery",
  "enabled",
  "description",
  "deleteAfterRun",
  "agentId",
  "sessionKey",
  "failureAlert",
  ...CRON_FLAT_PAYLOAD_KEYS,
  ...CRON_FLAT_SCHEDULE_KEYS,
]);

const REMINDER_CONTEXT_MESSAGES_MAX = 10;
const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
const REMINDER_CONTEXT_TOTAL_MAX = 700;
const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";

function isMissingOrEmptyObject(value: unknown): boolean {
  return !value || (isRecord(value) && Object.keys(value).length === 0);
}

function recoverCronObjectFromFlatParams(params: Record<string, unknown>): {
  found: boolean;
  value: Record<string, unknown>;
} {
  const value: Record<string, unknown> = {};
  let found = false;
  for (const key of Object.keys(params)) {
    if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) && params[key] !== undefined) {
      value[key] = params[key];
      found = true;
    }
  }
  if (value.everyMs === undefined && value.every !== undefined) {
    value.everyMs = value.every;
  }
  if (value.staggerMs === undefined && value.stagger !== undefined) {
    value.staggerMs = value.stagger;
  }
  if (value.exact === true && value.staggerMs === undefined) {
    value.staggerMs = 0;
  }
  delete value.every;
  delete value.stagger;
  delete value.exact;
  return { found, value };
}

function hasCronCreateSignal(value: Record<string, unknown>): boolean {
  return (
    value.schedule !== undefined ||
    value.at !== undefined ||
    value.atMs !== undefined ||
    value.everyMs !== undefined ||
    value.cron !== undefined ||
    value.expr !== undefined ||
    value.payload !== undefined ||
    value.message !== undefined ||
    value.text !== undefined
  );
}

function nullableStringSchema(description: string) {
  return Type.Optional(Type.String({ description }));
}

function nullableStringArraySchema(description: string) {
  return Type.Optional(Type.Array(Type.String(), { description }));
}

function cronPayloadObjectSchema(params: { toolsAllow: TSchema }) {
  return Type.Object(
    {
      kind: optionalStringEnum(CRON_PAYLOAD_KINDS, { description: "Payload kind" }),
      text: Type.Optional(Type.String({ description: "systemEvent text" })),
      message: Type.Optional(Type.String({ description: "agentTurn prompt" })),
      model: Type.Optional(Type.String({ description: "Model override" })),
      thinking: Type.Optional(Type.String({ description: "Thinking override" })),
      timeoutSeconds: Type.Optional(Type.Number()),
      lightContext: Type.Optional(Type.Boolean()),
      allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
      fallbacks: Type.Optional(Type.Array(Type.String(), { description: "Fallback models" })),
      toolsAllow: params.toolsAllow,
    },
    { additionalProperties: true },
  );
}

const CronScheduleSchema = Type.Optional(
  Type.Object(
    {
      kind: optionalStringEnum(CRON_SCHEDULE_KINDS, { description: "Schedule kind" }),
      at: Type.Optional(Type.String({ description: "ISO-8601 time (kind=at)" })),
      everyMs: Type.Optional(Type.Number({ description: "Interval ms (kind=every)" })),
      anchorMs: Type.Optional(Type.Number({ description: "Start anchor ms (kind=every)" })),
      expr: Type.Optional(
        Type.String({
          description:
            'Cron expr in tz wall-clock time; do not convert to UTC. Omitted tz => Gateway host local timezone. Example 6pm Shanghai daily: expr "0 18 * * *", tz "Asia/Shanghai".',
        }),
      ),
      tz: Type.Optional(
        Type.String({
          description:
            'IANA timezone for cron wall-clock fields, e.g. "Asia/Shanghai"; omitted => Gateway host local timezone.',
        }),
      ),
      staggerMs: Type.Optional(Type.Number({ description: "Jitter ms (kind=cron)" })),
    },
    { additionalProperties: true },
  ),
);

const CronPayloadSchema = Type.Optional(
  cronPayloadObjectSchema({
    toolsAllow: Type.Optional(Type.Array(Type.String(), { description: "Allowed tools" })),
  }),
);

const CronDeliverySchema = Type.Optional(
  Type.Object(
    {
      mode: optionalStringEnum(CRON_DELIVERY_MODES, { description: "Delivery mode" }),
      channel: Type.Optional(Type.String({ description: "Delivery channel" })),
      to: Type.Optional(Type.String({ description: "Delivery target" })),
      threadId: Type.Optional(
        Type.Union([Type.String(), Type.Number()], {
          description: "Thread/topic id",
        }),
      ),
      bestEffort: Type.Optional(Type.Boolean()),
      accountId: Type.Optional(Type.String({ description: "Delivery account" })),
      failureDestination: Type.Optional(
        Type.Object(
          {
            channel: Type.Optional(Type.String()),
            to: Type.Optional(Type.String()),
            accountId: Type.Optional(Type.String()),
            mode: optionalStringEnum(["announce", "webhook"] as const),
          },
          { additionalProperties: true },
        ),
      ),
    },
    { additionalProperties: true },
  ),
);

// Omitting `failureAlert` means "leave defaults/unchanged"; `false` explicitly disables alerts.
// Runtime handles `failureAlert === false` in cron/service/timer.ts.
// The schema declares `type: "object"` to stay compatible with providers that
// enforce an OpenAPI 3.0 subset (e.g. Gemini via GitHub Copilot).  The
// description tells the LLM that `false` is also accepted.
const CronFailureAlertSchema = Type.Optional(
  Type.Unsafe<Record<string, unknown> | false>({
    type: "object",
    properties: {
      after: Type.Optional(Type.Number({ description: "Failures before alert" })),
      channel: Type.Optional(Type.String({ description: "Alert channel" })),
      to: Type.Optional(Type.String({ description: "Alert target" })),
      cooldownMs: Type.Optional(Type.Number({ description: "Alert cooldown ms" })),
      includeSkipped: Type.Optional(
        Type.Boolean({ description: "Skipped runs count toward alert" }),
      ),
      mode: optionalStringEnum(["announce", "webhook"] as const),
      accountId: Type.Optional(Type.String()),
    },
    additionalProperties: true,
    description: "Failure alert object; false disables alerts",
  }),
);

const CronJobObjectSchema = Type.Optional(
  Type.Object(
    {
      name: Type.Optional(Type.String({ description: "Job name" })),
      schedule: CronScheduleSchema,
      sessionTarget: Type.Optional(
        Type.String({
          description: "main | isolated | current | session:<id>",
        }),
      ),
      wakeMode: optionalStringEnum(CRON_WAKE_MODES, { description: "Wake timing" }),
      payload: CronPayloadSchema,
      delivery: CronDeliverySchema,
      agentId: nullableStringSchema("Agent id, or null to keep it unset"),
      description: Type.Optional(Type.String({ description: "Human description" })),
      enabled: Type.Optional(Type.Boolean()),
      deleteAfterRun: Type.Optional(Type.Boolean({ description: "Delete after first run" })),
      sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
      failureAlert: CronFailureAlertSchema,
    },
    { additionalProperties: true },
  ),
);

const CronPatchObjectSchema = Type.Optional(
  Type.Object(
    {
      name: Type.Optional(Type.String({ description: "Job name" })),
      schedule: CronScheduleSchema,
      sessionTarget: Type.Optional(Type.String({ description: "Session target" })),
      wakeMode: optionalStringEnum(CRON_WAKE_MODES),
      payload: Type.Optional(
        cronPayloadObjectSchema({
          toolsAllow: nullableStringArraySchema("Allowed tool ids, or null to clear"),
        }),
      ),
      delivery: CronDeliverySchema,
      description: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
      deleteAfterRun: Type.Optional(Type.Boolean()),
      agentId: nullableStringSchema("Agent id, or null to clear it"),
      sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
      failureAlert: CronFailureAlertSchema,
    },
    { additionalProperties: true },
  ),
);

// Flattened schema: runtime validates per-action requirements.
export const CronToolSchema = Type.Object(
  {
    action: stringEnum(CRON_ACTIONS),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    includeDisabled: Type.Optional(Type.Boolean()),
    job: CronJobObjectSchema,
    jobId: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    patch: CronPatchObjectSchema,
    text: Type.Optional(Type.String()),
    mode: optionalStringEnum(CRON_WAKE_MODES),
    runMode: optionalStringEnum(CRON_RUN_MODES),
    contextMessages: Type.Optional(
      Type.Number({ minimum: 0, maximum: REMINDER_CONTEXT_MESSAGES_MAX }),
    ),
    agentId: Type.Optional(Type.String({ description: "List filter: agent id" })),
  },
  { additionalProperties: true },
);

type CronToolOptions = {
  agentSessionKey?: string;
  currentDeliveryContext?: DeliveryContext;
  selfRemoveOnlyJobId?: string;
};

type GatewayToolCaller = typeof callGatewayTool;

type CronToolDeps = {
  callGatewayTool?: GatewayToolCaller;
};

type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

function stripExistingContext(text: string) {
  const index = text.indexOf(REMINDER_CONTEXT_MARKER);
  if (index === -1) {
    return text;
  }
  return text.slice(0, index).trim();
}

function truncateText(input: string, maxLen: number) {
  if (input.length <= maxLen) {
    return input;
  }
  const truncated = truncateUtf16Safe(input, Math.max(0, maxLen - 3)).trimEnd();
  return `${truncated}...`;
}

function readCronJobIdParam(params: Record<string, unknown>) {
  return readStringParam(params, "jobId") ?? readStringParam(params, "id");
}

const CRON_SELF_REMOVE_SCOPE_ERROR = "Cron tool is restricted to the current cron job.";

function readCronSelfRemoveOnlyJobId(opts: CronToolOptions | undefined) {
  return opts?.selfRemoveOnlyJobId?.trim() || undefined;
}

function isCronSelfIntrospectionAction(action: string) {
  return action === "status" || action === "list";
}

function assertCronSelfRemoveScope(
  opts: CronToolOptions | undefined,
  action: string,
  params: Record<string, unknown>,
) {
  const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
  if (!selfRemoveOnlyJobId || isCronSelfIntrospectionAction(action)) {
    return;
  }
  if (action === "get" || action === "remove" || action === "runs") {
    const id = readCronJobIdParam(params);
    if (id && id === selfRemoveOnlyJobId) {
      return;
    }
  }
  throw new Error(CRON_SELF_REMOVE_SCOPE_ERROR);
}

function filterCronDeliveryPreviewsByJobId(previews: unknown, jobId: string): unknown {
  if (!isRecord(previews)) {
    return previews;
  }
  if (!Object.hasOwn(previews, jobId)) {
    return {};
  }
  return { [jobId]: previews[jobId] };
}

function filterCronListResultToJobId(result: unknown, jobId: string): unknown {
  if (!isRecord(result) || !Array.isArray(result.jobs)) {
    return result;
  }
  const jobs = result.jobs.filter((job) => isRecord(job) && job.id === jobId);
  return {
    ...result,
    jobs,
    total: jobs.length,
    offset: 0,
    limit: jobs.length,
    hasMore: false,
    nextOffset: null,
    ...(Object.hasOwn(result, "deliveryPreviews")
      ? { deliveryPreviews: filterCronDeliveryPreviewsByJobId(result.deliveryPreviews, jobId) }
      : {}),
  };
}

function filterCronStatusResultForSelfScope(result: unknown): unknown {
  return { enabled: isRecord(result) && result.enabled === true };
}

function cronListResultHasJob(result: unknown, jobId: string): boolean {
  return (
    isRecord(result) &&
    Array.isArray(result.jobs) &&
    result.jobs.some((job) => isRecord(job) && job.id === jobId)
  );
}

function readCronListNextOffset(result: unknown, currentOffset: number): number | undefined {
  if (!isRecord(result) || result.hasMore !== true || typeof result.nextOffset !== "number") {
    return undefined;
  }
  const nextOffset = Math.floor(result.nextOffset);
  return Number.isFinite(nextOffset) && nextOffset > currentOffset ? nextOffset : undefined;
}

function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = extractTextFromChatContent(message.content);
  return text ? { role, text } : null;
}

async function buildReminderContextLines(params: {
  agentSessionKey?: string;
  gatewayOpts: GatewayCallOptions;
  contextMessages: number;
  callGatewayTool: GatewayToolCaller;
}) {
  const maxMessages = Math.min(
    REMINDER_CONTEXT_MESSAGES_MAX,
    Math.max(0, Math.floor(params.contextMessages)),
  );
  if (maxMessages <= 0) {
    return [];
  }
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return [];
  }
  const cfg = getRuntimeConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const resolvedKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
  try {
    const res = await params.callGatewayTool<{ messages: Array<unknown> }>(
      "chat.history",
      params.gatewayOpts,
      {
        sessionKey: resolvedKey,
        limit: maxMessages,
      },
    );
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    const parsed = messages
      .map((msg) => extractMessageText(msg as ChatMessage))
      .filter((msg): msg is { role: string; text: string } => Boolean(msg));
    const recent = parsed.slice(-maxMessages);
    if (recent.length === 0) {
      return [];
    }
    const lines: string[] = [];
    let total = 0;
    for (const entry of recent) {
      const label = entry.role === "user" ? "User" : "Assistant";
      const text = truncateText(entry.text, REMINDER_CONTEXT_PER_MESSAGE_MAX);
      const line = `- ${label}: ${text}`;
      total += line.length;
      if (total > REMINDER_CONTEXT_TOTAL_MAX) {
        break;
      }
      lines.push(line);
    }
    return lines;
  } catch {
    return [];
  }
}

export function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  return {
    label: "Cron",
    name: "cron",
    ownerOnly: isOpenClawOwnerOnlyCoreToolName("cron"),
    displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
    description: `Manage Gateway cron jobs and wake events: reminders, check-back-later, delayed follow-ups, recurring work. Do not emulate scheduling with exec sleep/process polling.

Main cron => system events for heartbeat. Isolated cron => background task in \`openclaw tasks\`.

ACTIONS:
- status: scheduler status
- list: jobs; includeDisabled true includes disabled; agentId filter auto-filled from session
- get: one job; needs jobId
- add: create job; needs job object
- update: patch job; needs jobId + patch
- remove: delete job; needs jobId
- run: trigger now; needs jobId
- runs: run history; needs jobId
- wake: send wake event; needs text, optional mode

JOB SCHEMA (for add action):
{
  "name": "string",
  "schedule": { ... },      // required
  "payload": { ... },       // required
  "delivery": { ... },      // optional announce for isolated/current/session, webhook for any target
  "sessionTarget": "main" | "isolated" | "current" | "session:<id>",
  "enabled": true | false   // default true
}

SESSION TARGET OPTIONS:
- "main": main session; requires payload.kind="systemEvent"
- "isolated": ephemeral isolated session; requires payload.kind="agentTurn"
- "current": bind current session at creation
- "session:<id>": persistent named session

DEFAULTS:
- payload.kind="systemEvent" → defaults to "main"
- payload.kind="agentTurn" → defaults to "isolated"
Current binding needs sessionTarget="current".

SCHEDULE TYPES (schedule.kind):
- "at": one-shot absolute time
  { "kind": "at", "at": "<ISO-8601 timestamp>" }
- "every": recurring interval
  { "kind": "every", "everyMs": <ms>, "anchorMs": <optional-ms> }
- "cron": expr in supplied timezone, or Gateway host local timezone when tz omitted
  { "kind": "cron", "expr": "<cron-expression>", "tz": "<optional-IANA-timezone>" }
  Write expr in local wall-clock time; do not convert the requested local time to UTC first.
  tz omitted => Gateway host local timezone, not UTC.
  Example 6pm Shanghai daily: { "kind": "cron", "expr": "0 18 * * *", "tz": "Asia/Shanghai" }

For "at", ISO timestamps without timezone are UTC.

PAYLOAD TYPES (payload.kind):
- "systemEvent": inject text as system event
  { "kind": "systemEvent", "text": "<message>" }
- "agentTurn": run agent with prompt; isolated/current/session only
  { "kind": "agentTurn", "message": "<prompt>", "model": "<optional>", "thinking": "<optional>", "timeoutSeconds": <optional, 0=no timeout> }

DELIVERY (top-level):
  { "mode": "none|announce|webhook", "channel": "<optional>", "to": "<optional>", "threadId": "<optional>", "bestEffort": <optional-bool> }
  - isolated agentTurn default when omitted: "announce"
  - announce: send to chat channel; isolated/current/session only; optional channel/to
  - threadId: chat thread/topic id
  - webhook: POST finished-run event to delivery.to URL
  - Specific chat/recipient: set announce delivery.channel/to; do not call messaging tools inside run.

CRITICAL CONSTRAINTS:
- sessionTarget="main" REQUIRES payload.kind="systemEvent"
- sessionTarget="isolated" | "current" | "session:xxx" REQUIRES payload.kind="agentTurn"
- Webhook: delivery.mode="webhook" and delivery.to URL.
Default: prefer isolated agentTurn jobs unless the user explicitly wants current-session binding.

RESTRICTED CRON RUNS:
- Some isolated cron runs get narrow self-cleanup grant: status/list self-only, get/runs current job only, mutation only remove current job.

WAKE MODES (for wake action):
- "next-heartbeat" default: wake next heartbeat
- "now": wake immediately

Use jobId canonical; id accepted compat. contextMessages (0-10) adds previous messages as job context.`,
    parameters: CronToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      assertCronSelfRemoveScope(opts, action, params);
      const gatewayOpts: GatewayCallOptions = {
        ...readGatewayCallOptions(params),
        timeoutMs:
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : 60_000,
      };

      switch (action) {
        case "status": {
          const result = await callGateway("cron.status", gatewayOpts, {});
          return jsonResult(
            readCronSelfRemoveOnlyJobId(opts) ? filterCronStatusResultForSelfScope(result) : result,
          );
        }
        case "list": {
          const cfg = getRuntimeConfig();
          const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
          const listAgentId = selfRemoveOnlyJobId
            ? opts?.agentSessionKey?.trim()
              ? resolveSessionAgentId({ sessionKey: opts.agentSessionKey, config: cfg })
              : undefined
            : typeof params.agentId === "string" && params.agentId.trim()
              ? params.agentId.trim()
              : opts?.agentSessionKey
                ? resolveSessionAgentId({ sessionKey: opts.agentSessionKey, config: cfg })
                : undefined;
          const includeDisabled = Boolean(params.includeDisabled);
          let offset = 0;
          let result: unknown;
          let shouldContinue = true;
          while (shouldContinue) {
            result = await callGateway("cron.list", gatewayOpts, {
              includeDisabled,
              agentId: listAgentId,
              ...(selfRemoveOnlyJobId ? { limit: 200, offset } : {}),
            });
            if (!selfRemoveOnlyJobId || cronListResultHasJob(result, selfRemoveOnlyJobId)) {
              shouldContinue = false;
            } else {
              const nextOffset = readCronListNextOffset(result, offset);
              if (nextOffset === undefined) {
                shouldContinue = false;
              } else {
                offset = nextOffset;
              }
            }
          }
          return jsonResult(
            selfRemoveOnlyJobId ? filterCronListResultToJobId(result, selfRemoveOnlyJobId) : result,
          );
        }
        case "get": {
          const id = readCronJobIdParam(params);
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          return jsonResult(await callGateway("cron.get", gatewayOpts, { id }));
        }
        case "add": {
          // Flat-params recovery: non-frontier models (e.g. Grok) sometimes flatten
          // job properties to the top level alongside `action` instead of nesting
          // them inside `job`. When `params.job` is missing or empty, reconstruct
          // a synthetic job object from any recognised top-level job fields.
          // See: https://github.com/openclaw/openclaw/issues/11310
          if (isMissingOrEmptyObject(params.job)) {
            const synthetic = recoverCronObjectFromFlatParams(params);
            // Only use the synthetic job if at least one meaningful field is present
            // (schedule, payload, message, or text are the minimum signals that the
            // LLM intended to create a job).
            if (synthetic.found && hasCronCreateSignal(synthetic.value)) {
              params.job = synthetic.value;
            }
          }

          if (!params.job || typeof params.job !== "object") {
            throw new Error("job required");
          }
          const job =
            normalizeCronJobCreate(params.job, {
              sessionContext: { sessionKey: opts?.agentSessionKey },
            }) ?? params.job;
          const cfg = getRuntimeConfig();
          if (job && typeof job === "object") {
            const { mainKey, alias } = resolveMainSessionAlias(cfg);
            const resolvedSessionKey = opts?.agentSessionKey
              ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
              : undefined;
            if (!("agentId" in job) || (job as { agentId?: unknown }).agentId === undefined) {
              const agentId = opts?.agentSessionKey
                ? resolveSessionAgentId({ sessionKey: opts.agentSessionKey, config: cfg })
                : undefined;
              if (agentId) {
                (job as { agentId?: string }).agentId = agentId;
              }
            }
            if (!("sessionKey" in job) && resolvedSessionKey) {
              (job as { sessionKey?: string }).sessionKey = resolvedSessionKey;
            }
          }

          if (
            (opts?.agentSessionKey || opts?.currentDeliveryContext) &&
            job &&
            typeof job === "object" &&
            "payload" in job &&
            (job as { payload?: { kind?: string } }).payload?.kind === "agentTurn"
          ) {
            const deliveryValue = (job as { delivery?: unknown }).delivery;
            const delivery = isRecord(deliveryValue) ? deliveryValue : undefined;
            const modeRaw = typeof delivery?.mode === "string" ? delivery.mode : "";
            const mode = normalizeLowercaseStringOrEmpty(modeRaw);
            if (mode === "webhook") {
              const webhookUrl = normalizeHttpWebhookUrl(delivery?.to);
              if (!webhookUrl) {
                throw new Error(
                  'delivery.mode="webhook" requires delivery.to to be a valid http(s) URL',
                );
              }
              if (delivery) {
                delivery.to = webhookUrl;
              }
            }

            const hasTarget =
              (typeof delivery?.channel === "string" && delivery.channel.trim()) ||
              (typeof delivery?.to === "string" && delivery.to.trim());
            const shouldInfer =
              (deliveryValue == null || delivery) &&
              (mode === "" || mode === "announce") &&
              !hasTarget;
            if (shouldInfer) {
              const inferred = resolveCronCreationDelivery({
                cfg,
                currentDeliveryContext: opts.currentDeliveryContext,
                agentSessionKey: opts.agentSessionKey,
              });
              if (inferred) {
                (job as { delivery?: unknown }).delivery = {
                  ...inferred,
                  ...delivery,
                } satisfies CronDelivery;
              }
            }
          }

          const contextMessages =
            typeof params.contextMessages === "number" && Number.isFinite(params.contextMessages)
              ? params.contextMessages
              : 0;
          if (
            job &&
            typeof job === "object" &&
            "payload" in job &&
            (job as { payload?: { kind?: string; text?: string } }).payload?.kind === "systemEvent"
          ) {
            const payload = (job as { payload: { kind: string; text: string } }).payload;
            if (typeof payload.text === "string" && payload.text.trim()) {
              const contextLines = await buildReminderContextLines({
                agentSessionKey: opts?.agentSessionKey,
                gatewayOpts,
                contextMessages,
                callGatewayTool: callGateway,
              });
              if (contextLines.length > 0) {
                const baseText = stripExistingContext(payload.text);
                payload.text = `${baseText}${REMINDER_CONTEXT_MARKER}${contextLines.join("\n")}`;
              }
            }
          }
          return jsonResult(await callGateway("cron.add", gatewayOpts, job));
        }
        case "update": {
          const id = readCronJobIdParam(params);
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }

          // Flat-params recovery for patch
          let recoveredFlatPatch = false;
          if (isMissingOrEmptyObject(params.patch)) {
            const synthetic = recoverCronObjectFromFlatParams(params);
            if (synthetic.found) {
              params.patch = synthetic.value;
              recoveredFlatPatch = true;
            }
          }

          if (!params.patch || typeof params.patch !== "object") {
            throw new Error("patch required");
          }
          const patch = normalizeCronJobPatch(params.patch) ?? params.patch;
          if (
            recoveredFlatPatch &&
            typeof patch === "object" &&
            patch !== null &&
            Object.keys(patch as Record<string, unknown>).length === 0
          ) {
            throw new Error("patch required");
          }
          return jsonResult(
            await callGateway("cron.update", gatewayOpts, {
              id,
              patch,
            }),
          );
        }
        case "remove": {
          const id = readCronJobIdParam(params);
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          return jsonResult(await callGateway("cron.remove", gatewayOpts, { id }));
        }
        case "run": {
          const id = readCronJobIdParam(params);
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          const runMode =
            params.runMode === "due" || params.runMode === "force" ? params.runMode : "force";
          return jsonResult(await callGateway("cron.run", gatewayOpts, { id, mode: runMode }));
        }
        case "runs": {
          const id = readCronJobIdParam(params);
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          return jsonResult(await callGateway("cron.runs", gatewayOpts, { id }));
        }
        case "wake": {
          const text = readStringParam(params, "text", { required: true });
          const mode =
            params.mode === "now" || params.mode === "next-heartbeat"
              ? params.mode
              : "next-heartbeat";
          return jsonResult(
            await callGateway("wake", gatewayOpts, { mode, text }, { expectFinal: false }),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
