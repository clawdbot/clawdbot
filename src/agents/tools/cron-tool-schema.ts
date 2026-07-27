/** Model-facing schema and input validation for the cron tool. */
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

// Spell out job/patch properties for model-facing schema; runtime validation
// still happens in normalizeCronJob* to avoid nested union schemas.

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
const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn", "script"] as const;
const CRON_DELIVERY_MODES = ["none", "announce", "webhook"] as const;
const CRON_RUN_MODES = ["due", "force"] as const;

function nullableStringSchema(description: string) {
  return Type.Optional(Type.Union([Type.String(), Type.Null()], { description }));
}
function nullableStringArraySchema(description: string) {
  return Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()], { description }));
}

function deliveryStringSchema(params: { description: string; nullableClears: boolean }) {
  return params.nullableClears
    ? nullableStringSchema(`${params.description}, or null to clear`)
    : Type.Optional(Type.String({ description: params.description }));
}

function deliveryThreadIdSchema(params: { nullableClears: boolean }) {
  const variants = params.nullableClears
    ? [Type.String(), Type.Number(), Type.Null()]
    : [Type.String(), Type.Number()];
  return Type.Optional(Type.Union(variants, { description: "Thread/topic id" }));
}

function failureDestinationModeSchema(params: { nullableClears: boolean }) {
  const variants = params.nullableClears
    ? [Type.Literal("announce"), Type.Literal("webhook"), Type.Null()]
    : [Type.Literal("announce"), Type.Literal("webhook")];
  return Type.Optional(Type.Union(variants));
}

function cronPayloadObjectSchema(params: {
  model: TSchema;
  toolsAllow: TSchema;
  fallbacks: TSchema;
}) {
  return Type.Object(
    {
      kind: optionalStringEnum(CRON_PAYLOAD_KINDS, { description: "Payload kind" }),
      text: Type.Optional(Type.String({ description: "systemEvent text" })),
      message: Type.Optional(Type.String({ description: "agentTurn prompt" })),
      script: Type.Optional(Type.String({ description: "Headless code-mode script" })),
      model: params.model,
      thinking: Type.Optional(Type.String({ description: "Thinking override" })),
      timeoutSeconds: optionalFiniteNumberSchema({ minimum: 0 }),
      toolBudget: optionalPositiveIntegerSchema({ description: "Maximum script tool calls" }),
      lightContext: Type.Optional(
        Type.Boolean({
          description: "Lightweight bootstrap context (skip full workspace context)",
        }),
      ),
      allowUnsafeExternalContent: Type.Optional(
        Type.Boolean({ description: "Allow untrusted external content in prompt" }),
      ),
      fallbacks: params.fallbacks,
      toolsAllow: params.toolsAllow,
    },
    { additionalProperties: true },
  );
}

function createCronScheduleSchema(): TSchema {
  return Type.Optional(
    Type.Object(
      {
        kind: optionalStringEnum(CRON_SCHEDULE_KINDS, { description: "Schedule kind" }),
        at: Type.Optional(Type.String({ description: "ISO-8601 time (kind=at)" })),
        everyMs: optionalPositiveIntegerSchema({ description: "Interval ms (kind=every)" }),
        anchorMs: optionalNonNegativeIntegerSchema({
          description: "Start anchor ms (kind=every)",
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
        staggerMs: optionalNonNegativeIntegerSchema({ description: "Jitter ms (kind=cron)" }),
        command: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            description: "Supervised source argv (kind=stream; requires cron.triggers.enabled)",
          }),
        ),
        cwd: Type.Optional(Type.String({ description: "Working directory (kind=stream)" })),
        mode: optionalStringEnum(["line", "match"] as const),
        match: Type.Optional(Type.String({ description: "Regex source (stream match mode)" })),
        batchMs: optionalNonNegativeIntegerSchema(),
        maxBatchBytes: optionalNonNegativeIntegerSchema(),
      },
      { additionalProperties: true },
    ),
  );
}

function createCronPacingSchema(params: { nullableClears: boolean }): TSchema {
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
  return Type.Optional(params.nullableClears ? Type.Union([pacing, Type.Null()]) : pacing);
}

export function assertCronPacingInput(value: unknown, params: { nullableClears: boolean }): void {
  if (value === undefined || (params.nullableClears && value === null)) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error("cron pacing must be an object");
  }
  parseCronPacingBounds(value as CronPacing);
}

function createCronPayloadSchema(): TSchema {
  return Type.Optional(
    cronPayloadObjectSchema({
      model: Type.Optional(Type.String({ description: "Model override" })),
      toolsAllow: Type.Optional(Type.Array(Type.String(), { description: "Allowed tools" })),
      fallbacks: Type.Optional(Type.Array(Type.String(), { description: "Fallback models" })),
    }),
  );
}

function createCronTriggerSchema(params: { nullableClears: boolean }): TSchema {
  const trigger = Type.Object(
    {
      script: Type.String({ minLength: 1, maxLength: 65_536 }),
      once: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  return Type.Optional(params.nullableClears ? Type.Union([trigger, Type.Null()]) : trigger);
}

function cronDeliverySchema(params: { nullableClears: boolean }) {
  const failureDestinationObject = Type.Object(
    {
      channel: deliveryStringSchema({
        description: "Failure delivery channel",
        nullableClears: params.nullableClears,
      }),
      to: deliveryStringSchema({
        description: "Failure delivery target",
        nullableClears: params.nullableClears,
      }),
      accountId: deliveryStringSchema({
        description: "Failure delivery account",
        nullableClears: params.nullableClears,
      }),
      mode: failureDestinationModeSchema({ nullableClears: params.nullableClears }),
    },
    { additionalProperties: true },
  );

  return Type.Optional(
    Type.Object(
      {
        mode: optionalStringEnum(CRON_DELIVERY_MODES, { description: "Delivery mode" }),
        channel: deliveryStringSchema({
          description: "Delivery channel",
          nullableClears: params.nullableClears,
        }),
        to: deliveryStringSchema({
          description: "Delivery target",
          nullableClears: params.nullableClears,
        }),
        threadId: deliveryThreadIdSchema({ nullableClears: params.nullableClears }),
        bestEffort: Type.Optional(Type.Boolean()),
        accountId: deliveryStringSchema({
          description: "Delivery account",
          nullableClears: params.nullableClears,
        }),
        failureDestination: params.nullableClears
          ? Type.Optional(
              Type.Union([failureDestinationObject, Type.Null()], {
                description: "Failure destination; null clears.",
              }),
            )
          : Type.Optional(failureDestinationObject),
      },
      { additionalProperties: true },
    ),
  );
}

function createCronDeliverySchema(): TSchema {
  return cronDeliverySchema({ nullableClears: false });
}

function createCronDeliveryPatchSchema(): TSchema {
  return cronDeliverySchema({ nullableClears: true });
}

// Omitting `failureAlert` means "leave defaults/unchanged"; `false` explicitly disables alerts.
// Runtime handles `failureAlert === false` in cron/service/timer.ts.
// The schema declares `type: "object"` to stay compatible with providers that
// enforce an OpenAPI 3.0 subset (e.g. Gemini via GitHub Copilot).  The
// description tells the LLM that `false` is also accepted.
function createCronFailureAlertSchema(): TSchema {
  return Type.Optional(
    Type.Unsafe<Record<string, unknown> | false>({
      type: "object",
      properties: {
        after: optionalPositiveIntegerSchema({ description: "Failures before alert" }),
        channel: Type.Optional(Type.String({ description: "Alert channel" })),
        to: Type.Optional(Type.String({ description: "Alert target" })),
        cooldownMs: optionalNonNegativeIntegerSchema({ description: "Alert cooldown ms" }),
        includeSkipped: Type.Optional(Type.Boolean({ description: "Count skipped runs." })),
        mode: optionalStringEnum(["announce", "webhook"] as const),
        accountId: Type.Optional(Type.String()),
      },
      additionalProperties: true,
      description: "Failure alert; false disables.",
    }),
  );
}

function createCronJobObjectSchema(): TSchema {
  return Type.Optional(
    Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Job name" })),
        declarationKey: Type.Optional(
          Type.String({
            description: "Idempotent declaration key.",
            minLength: 1,
            maxLength: 200,
          }),
        ),
        displayName: Type.Optional(
          Type.String({ description: "Human-readable declarative job label", maxLength: 200 }),
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
        schedule: createCronScheduleSchema(),
        pacing: createCronPacingSchema({ nullableClears: false }),
        trigger: createCronTriggerSchema({ nullableClears: false }),
        sessionTarget: Type.Optional(
          Type.String({
            description: "main | isolated | current (agentTurn default) | session:<id>",
          }),
        ),
        wakeMode: optionalStringEnum(CRON_WAKE_MODES, { description: "Wake timing" }),
        payload: createCronPayloadSchema(),
        delivery: createCronDeliverySchema(),
        agentId: nullableStringSchema("Agent id, or null to keep it unset"),
        description: Type.Optional(Type.String({ description: "Human description" })),
        enabled: Type.Optional(Type.Boolean()),
        deleteAfterRun: Type.Optional(Type.Boolean({ description: "Delete after first run" })),
        sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
        failureAlert: createCronFailureAlertSchema(),
      },
      { additionalProperties: true },
    ),
  );
}

function createCronPatchObjectSchema(): TSchema {
  return Type.Optional(
    Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Job name" })),
        displayName: Type.Optional(
          Type.Union([Type.String({ maxLength: 200 }), Type.Null()], {
            description: "Human-readable label; null clears it",
          }),
        ),
        schedule: createCronScheduleSchema(),
        pacing: createCronPacingSchema({ nullableClears: true }),
        trigger: createCronTriggerSchema({ nullableClears: true }),
        sessionTarget: Type.Optional(
          Type.String({
            description: "main | isolated | current (agentTurn default) | session:<id>",
          }),
        ),
        wakeMode: optionalStringEnum(CRON_WAKE_MODES),
        payload: Type.Optional(
          cronPayloadObjectSchema({
            model: nullableStringSchema("Model override, or null to clear"),
            toolsAllow: nullableStringArraySchema("Allowed tool ids, or null to clear"),
            fallbacks: nullableStringArraySchema("Fallback models, or null to clear"),
          }),
        ),
        delivery: createCronDeliveryPatchSchema(),
        description: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
        deleteAfterRun: Type.Optional(Type.Boolean()),
        agentId: nullableStringSchema("Agent id, or null to clear it"),
        sessionKey: nullableStringSchema("Explicit session key, or null to clear it"),
        failureAlert: createCronFailureAlertSchema(),
      },
      { additionalProperties: true },
    ),
  );
}

// Flattened schema: runtime validates per-action requirements.
export function createCronToolSchema(): TSchema {
  return Type.Object(
    {
      action: stringEnum(CRON_ACTIONS),
      ...gatewayCallOptionSchemaProperties(),
      includeDisabled: Type.Optional(Type.Boolean()),
      job: createCronJobObjectSchema(),
      jobId: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      patch: createCronPatchObjectSchema(),
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
