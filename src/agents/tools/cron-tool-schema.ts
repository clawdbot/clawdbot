/** Model-facing schema and input validation for the cron tool. */
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { Type, type TSchema } from "typebox";
import { parseCronPacingBounds } from "../../cron/pacing.js";
import type { CronPacing } from "../../cron/types.js";
import { isRecord } from "../../utils.js";
import {
  optionalFiniteNumberSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "../schema/typebox.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";

export const REMINDER_CONTEXT_MESSAGES_MAX = 10;
export const CRON_TOOL_LIST_MAX_LIMIT = 200;

// Spell out job properties for the model-facing schema; runtime validation
// still happens in normalizeCronJob* to avoid nested union schemas. One object
// schema serves both add (full job) and update (partial patch; null clears) so
// the near-duplicate shape ships once per prompt instead of twice (#121606).

const CRON_ACTIONS = [
  "status",
  "list",
  "get",
  "add",
  "update",
  "remove",
  "run",
  "runs",
  "next_check",
  "wake",
] as const;

const CRON_SCHEDULE_KINDS = ["at", "every", "cron", "stream"] as const;
// When cron.triggers.enabled is explicitly false, the scheduler rejects
// stream schedules, script payloads, and condition triggers, so the
// model-facing schema must not advertise them.
const CRON_SCHEDULE_KINDS_TRIGGERS_DISABLED = ["at", "every", "cron"] as const;
const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn", "script"] as const;
const CRON_PAYLOAD_KINDS_TRIGGERS_DISABLED = ["systemEvent", "agentTurn"] as const;
const CRON_DELIVERY_MODES = ["none", "announce", "webhook"] as const;
const CRON_RUN_MODES = ["due", "force"] as const;

type CronToolSchemaOptions = {
  agentSessionKey?: string;
  /**
   * Whether cron.triggers.enabled is on for this deployment. When false, the
   * trigger-gated surfaces (job trigger, script payloads, stream
   * schedules) are omitted from the advertised schema so models cannot be
   * tempted into calls the scheduler always rejects. Defaults to true so
   * config-less callers keep the full surface.
   */
  triggersEnabled?: boolean;
};

function nullableStringSchema(description: string) {
  return Type.Optional(Type.Union([Type.String(), Type.Null()], { description }));
}
function nullableStringArraySchema(description: string) {
  return Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()], { description }));
}

function deliveryStringSchema(description: string) {
  return nullableStringSchema(`${description}, or null to clear`);
}

function createCronScheduleSchema(params: { triggersEnabled: boolean }): TSchema {
  return Type.Optional(
    Type.Object(
      {
        kind: optionalStringEnum(
          params.triggersEnabled ? CRON_SCHEDULE_KINDS : CRON_SCHEDULE_KINDS_TRIGGERS_DISABLED,
          { description: "Schedule kind" },
        ),
        at: Type.Optional(Type.String({ description: "ISO-8601 time (kind=at)" })),
        everyMs: optionalPositiveIntegerSchema({
          description: "Interval ms (kind=every)",
          maximum: MAX_DATE_TIMESTAMP_MS,
        }),
        anchorMs: optionalNonNegativeIntegerSchema({
          description: "Start anchor ms (kind=every)",
          maximum: MAX_DATE_TIMESTAMP_MS,
        }),
        expr: Type.Optional(
          Type.String({
            description:
              'Cron wall-time expr; never UTC-convert. Missing tz=Gateway local. Example "0 18 * * *", "Asia/Shanghai".',
          }),
        ),
        tz: Type.Optional(
          Type.String({
            description:
              'IANA timezone for wall-clock fields; missing=Gateway host local timezone. Example "Asia/Shanghai".',
          }),
        ),
        staggerMs: optionalNonNegativeIntegerSchema({
          description: "Jitter ms (kind=cron)",
          maximum: MAX_DATE_TIMESTAMP_MS,
        }),
        ...(params.triggersEnabled
          ? {
              command: Type.Optional(
                Type.Array(Type.String({ minLength: 1 }), {
                  minItems: 1,
                  description:
                    "Supervised source argv (kind=stream; disabled when cron.triggers.enabled=false)",
                }),
              ),
              cwd: Type.Optional(Type.String({ description: "Working directory (kind=stream)" })),
              mode: optionalStringEnum(["line", "match"] as const),
              match: Type.Optional(
                Type.String({ description: "Regex source (stream match mode)" }),
              ),
              batchMs: optionalNonNegativeIntegerSchema(),
              maxBatchBytes: optionalNonNegativeIntegerSchema(),
            }
          : {}),
      },
      { additionalProperties: true },
    ),
  );
}

function createCronPacingSchema(): TSchema {
  const pacing = Type.Object(
    {
      min: Type.Optional(Type.String({ description: "Minimum dynamic delay" })),
      max: Type.Optional(Type.String({ description: "Maximum dynamic delay" })),
    },
    {
      additionalProperties: false,
      description: "Dynamic-cadence bounds; at least one of min or max is required",
    },
  );
  return Type.Optional(Type.Union([pacing, Type.Null()]));
}

export function assertCronPacingInput(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error("cron pacing must be an object");
  }
  parseCronPacingBounds(value as CronPacing);
}

function createCronPayloadSchema(params: { triggersEnabled: boolean }): TSchema {
  return Type.Optional(
    Type.Object(
      {
        kind: optionalStringEnum(
          params.triggersEnabled ? CRON_PAYLOAD_KINDS : CRON_PAYLOAD_KINDS_TRIGGERS_DISABLED,
          { description: "Payload kind" },
        ),
        text: Type.Optional(Type.String({ description: "systemEvent text" })),
        message: Type.Optional(Type.String({ description: "agentTurn prompt" })),
        ...(params.triggersEnabled
          ? {
              script: Type.Optional(Type.String({ description: "Headless code-mode script" })),
            }
          : {}),
        model: nullableStringSchema("Model override, or null to clear"),
        thinking: Type.Optional(Type.String({ description: "Thinking override" })),
        timeoutSeconds: optionalFiniteNumberSchema({ minimum: 0 }),
        ...(params.triggersEnabled
          ? {
              toolBudget: optionalPositiveIntegerSchema({
                description: "Maximum script tool calls",
              }),
            }
          : {}),
        lightContext: Type.Optional(
          Type.Boolean({
            description: "Lightweight bootstrap context (skip full workspace context)",
          }),
        ),
        allowUnsafeExternalContent: Type.Optional(
          Type.Boolean({ description: "Allow untrusted external content in prompt" }),
        ),
        fallbacks: nullableStringArraySchema("Fallback models, or null to clear"),
        toolsAllow: nullableStringArraySchema("Allowed tool ids, or null to clear"),
      },
      { additionalProperties: true },
    ),
  );
}

function createCronTriggerSchema(): TSchema {
  const trigger = Type.Object(
    {
      script: Type.String({ minLength: 1, maxLength: 65_536 }),
      once: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  return Type.Optional(Type.Union([trigger, Type.Null()]));
}

function createCronDeliverySchema(): TSchema {
  const failureDestinationObject = Type.Object(
    {
      channel: deliveryStringSchema("Failure delivery channel"),
      to: deliveryStringSchema("Failure delivery target"),
      accountId: deliveryStringSchema("Failure delivery account"),
      mode: Type.Optional(
        Type.Union([Type.Literal("announce"), Type.Literal("webhook"), Type.Null()]),
      ),
    },
    { additionalProperties: true },
  );
  const completionDestinationObject = Type.Object(
    {
      mode: Type.Literal("webhook"),
      to: Type.String({
        minLength: 1,
        description: "Completion webhook target; only valid with delivery.mode=announce",
      }),
    },
    { additionalProperties: true },
  );

  return Type.Optional(
    Type.Object(
      {
        mode: optionalStringEnum(CRON_DELIVERY_MODES, { description: "Delivery mode" }),
        channel: deliveryStringSchema("Delivery channel"),
        to: deliveryStringSchema("Delivery target"),
        threadId: Type.Optional(
          Type.Union([Type.String(), Type.Number(), Type.Null()], {
            description: "Thread/topic id",
          }),
        ),
        bestEffort: Type.Optional(
          Type.Boolean({
            description:
              "Omitted/false requires requested delivery for successful completion; true lets successful execution complete and delete a one-shot despite failed/unknown delivery. Intentional silence succeeds in either mode.",
          }),
        ),
        accountId: deliveryStringSchema("Delivery account"),
        failureDestination: Type.Optional(
          Type.Union([failureDestinationObject, Type.Null()], {
            description:
              "Failure-alert route override; required-delivery failures bypass after but share the execution-alert cooldown; null clears.",
          }),
        ),
        completionDestination: Type.Optional(
          Type.Union([completionDestinationObject, Type.Null()], {
            description: "Completion webhook; requires delivery.mode=announce; null clears.",
          }),
        ),
      },
      { additionalProperties: true },
    ),
  );
}

// Omitting `failureAlert` means "leave defaults/unchanged"; `false` disables regular alerts.
// Runtime handles `failureAlert === false` in cron/service/failure-alerts.ts.
// The schema declares `type: "object"` to stay compatible with providers that
// enforce an OpenAPI 3.0 subset (e.g. Gemini via GitHub Copilot).  The
// description tells the LLM that `false` is also accepted.
function createCronFailureAlertSchema(): TSchema {
  return Type.Optional(
    Type.Unsafe<Record<string, unknown> | false>({
      type: "object",
      properties: {
        after: optionalPositiveIntegerSchema({
          description:
            "Consecutive execution failures before alert; delivery failures bypass this threshold",
        }),
        channel: Type.Optional(Type.String({ description: "Alert channel" })),
        to: Type.Optional(Type.String({ description: "Alert target" })),
        cooldownMs: optionalNonNegativeIntegerSchema({ description: "Alert cooldown ms" }),
        includeSkipped: Type.Optional(Type.Boolean({ description: "Count skipped runs." })),
        mode: optionalStringEnum(["announce", "webhook"] as const),
        accountId: Type.Optional(Type.String()),
      },
      additionalProperties: true,
      description:
        "Failure alert policy/route override. Route-backed jobs default to after=2 for execution failures and cooldownMs=3600000 for all failure alerts; false disables execution/delivery alerts but not the auto-disable safety notice.",
    }),
  );
}

// Flattened schema: runtime validates per-action requirements.
export function createCronToolSchema(options?: CronToolSchemaOptions): TSchema {
  const triggersEnabled = options?.triggersEnabled !== false;
  const job = Type.Optional(
    Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Job name" })),
        declarationKey: Type.Optional(
          Type.String({
            description: "Idempotent declaration key (add only).",
            minLength: 1,
            maxLength: 200,
          }),
        ),
        displayName: Type.Optional(
          Type.Union([Type.String({ maxLength: 200 }), Type.Null()], {
            description: "Human-readable label; null clears it",
          }),
        ),
        owner: Type.Optional(
          Type.Object(
            {
              agentId: Type.Optional(Type.String()),
              sessionKey: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        schedule: createCronScheduleSchema({ triggersEnabled }),
        pacing: createCronPacingSchema(),
        ...(triggersEnabled ? { trigger: createCronTriggerSchema() } : {}),
        sessionTarget: Type.Optional(
          Type.String({
            description: "main | isolated | current (agentTurn default) | session:<id>",
          }),
        ),
        wakeMode: optionalStringEnum(CRON_WAKE_MODES, { description: "Wake timing" }),
        payload: createCronPayloadSchema({ triggersEnabled }),
        delivery: createCronDeliverySchema(),
        // Session-scoped updates reject retargeting; do not advertise it to the model.
        ...(!options?.agentSessionKey?.trim()
          ? { agentId: nullableStringSchema("Agent id, or null to clear it") }
          : {}),
        description: Type.Optional(Type.String({ description: "Human description" })),
        enabled: Type.Optional(Type.Boolean()),
        deleteAfterRun: Type.Optional(
          Type.Boolean({
            description:
              "Delete one-shot after successful completion: delivery confirmed, not requested, intentionally silent, or explicitly bestEffort. Failed/unknown required delivery retains it disabled.",
          }),
        ),
        sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
        failureAlert: createCronFailureAlertSchema(),
      },
      {
        additionalProperties: true,
        description:
          'Job fields. action="add": full job. action="update": partial patch — only supplied fields change; null clears.',
      },
    ),
  );
  return Type.Object(
    {
      action: stringEnum(CRON_ACTIONS),
      ...gatewayCallOptionSchemaProperties(),
      includeDisabled: Type.Optional(Type.Boolean()),
      limit: optionalPositiveIntegerSchema({
        maximum: CRON_TOOL_LIST_MAX_LIMIT,
        description: 'Maximum jobs returned by action="list"',
      }),
      offset: optionalNonNegativeIntegerSchema({
        description: 'Job offset for action="list"; use nextOffset to load the next page',
      }),
      job,
      jobId: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      in: Type.Optional(
        Type.String({
          description: 'Relative duration for action="next_check" (for example, "15m")',
        }),
      ),
      text: Type.Optional(Type.String({ description: 'systemEvent text for action="wake"' })),
      mode: optionalStringEnum(CRON_WAKE_MODES, {
        description: 'Wake mode for action="wake" (default next-heartbeat)',
      }),
      runMode: optionalStringEnum(CRON_RUN_MODES, {
        description:
          'Run mode for action="run": omitted defaults to "due"; use "force" to trigger now.',
      }),
      contextMessages: Type.Optional(
        Type.Integer({ minimum: 0, maximum: REMINDER_CONTEXT_MESSAGES_MAX }),
      ),
      agentId: Type.Optional(
        Type.String({
          description:
            'List filter for `action: "list"`; wake target override for `action: "wake"` (defaults to the calling agent when omitted on wake)',
        }),
      ),
      sessionKey: Type.Optional(
        Type.String({
          description:
            'Wake target override for `action: "wake"`: route the event to another session owned by the calling agent. Defaults to the resolved calling-session key when omitted.',
        }),
      ),
    },
    { additionalProperties: true },
  );
}
