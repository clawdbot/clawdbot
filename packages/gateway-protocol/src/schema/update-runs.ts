import { Type, type Static } from "typebox";
import {
  UPDATE_RUN_DRIVER_LIMIT,
  UPDATE_RUN_PHASES,
  UPDATE_RUN_STATUSES,
  UPDATE_RUN_STEP_STATUSES,
  UPDATE_RUN_TRIGGERS,
} from "../update-run-vocabulary.js";
import { closedObject } from "./closed-object.js";

const text = Type.String({ maxLength: 1024 });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
// Match the ledger's RFC 9562 UUID contract, including nil/max UUIDs.
const runId = Type.String({
  pattern:
    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
});
const phase = Type.Enum(UPDATE_RUN_PHASES);
const status = Type.Enum(UPDATE_RUN_STATUSES);
const version = closedObject({
  version: Type.Optional(Type.Union([text, Type.Null()])),
  sha: Type.Optional(Type.Union([text, Type.Null()])),
  buildId: Type.Optional(Type.Union([text, Type.Null()])),
});
const driver = closedObject({
  host: Type.String({ minLength: 1, maxLength: 255 }),
  pid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  startIdentity: Type.String({ pattern: "^\\d+$", maxLength: 128 }),
});

/** Wire projection of the canonical update ledger record. */
export const UpdateRunRecordSchema = closedObject({
  runId,
  createdAtMs: timestamp,
  updatedAtMs: timestamp,
  trigger: Type.Enum(UPDATE_RUN_TRIGGERS),
  phase,
  status,
  reason: Type.Union([text, Type.Null()]),
  origin: closedObject({
    driver: Type.Optional(driver),
    previousDrivers: Type.Optional(Type.Array(driver, { maxItems: UPDATE_RUN_DRIVER_LIMIT - 1 })),
    requester: Type.Optional(
      closedObject({
        channel: Type.Optional(text),
        accountId: Type.Optional(text),
        senderId: Type.Optional(text),
      }),
    ),
    sessionKey: Type.Optional(text),
    deliveryContext: Type.Optional(
      closedObject({
        channel: Type.Optional(text),
        to: Type.Optional(text),
        accountId: Type.Optional(text),
        threadId: Type.Optional(text),
      }),
    ),
    campaignId: Type.Optional(text),
    doctorHint: Type.Optional(text),
    nextAction: Type.Optional(text),
  }),
  target: closedObject({
    channel: Type.Optional(text),
    tag: Type.Optional(text),
    kind: Type.Optional(Type.Enum(["package", "git"])),
    version: Type.Optional(text),
    sha: Type.Optional(text),
  }),
  before: version,
  after: version,
  steps: Type.Array(
    closedObject({
      step: text,
      status: Type.Enum(UPDATE_RUN_STEP_STATUSES),
      startedAtMs: Type.Optional(timestamp),
      endedAtMs: Type.Optional(timestamp),
      detail: Type.Optional(text),
    }),
    { maxItems: 128 },
  ),
  verification: closedObject({
    booted: Type.Optional(Type.Boolean()),
    runningVersion: Type.Optional(text),
    runningBuildId: Type.Optional(text),
    serviceRunning: Type.Optional(Type.Boolean()),
    pid: Type.Optional(timestamp),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    versionMatch: Type.Optional(Type.Boolean()),
    pluginErrors: Type.Optional(Type.Array(text, { maxItems: 32 })),
    channelsReady: Type.Optional(Type.Boolean()),
    readyz: Type.Optional(Type.Boolean()),
    settled: Type.Optional(Type.Boolean()),
    noticeDelivered: Type.Optional(Type.Boolean()),
    doctorHint: Type.Optional(text),
  }),
  repair: Type.Array(
    closedObject({
      attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      status: Type.Enum(["succeeded", "failed", "skipped"]),
      startedAtMs: timestamp,
      endedAtMs: Type.Optional(timestamp),
      summary: Type.Optional(text),
      reason: Type.Optional(text),
    }),
    { maxItems: 16 },
  ),
  confirmedAtMs: Type.Union([timestamp, Type.Null()]),
  finishedAtMs: Type.Union([timestamp, Type.Null()]),
  downtimeMs: Type.Union([timestamp, Type.Null()]),
});

export const UpdateRunsGetParamsSchema = closedObject({ runId });
export const UpdateRunsGetResultSchema = closedObject({
  run: Type.Union([UpdateRunRecordSchema, Type.Null()]),
});
export const UpdateRunsListParamsSchema = closedObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const UpdateRunsListResultSchema = closedObject({
  runs: Type.Array(UpdateRunRecordSchema, { maxItems: 100 }),
});
export const UpdateRunChangedEventSchema = closedObject({
  runId,
  phase,
  status,
  updatedAtMs: timestamp,
});

/** Existing update.run response fields remain available alongside the durable run identity. */
export const UpdateRunResultSchema = closedObject({
  runId,
  ok: Type.Boolean(),
  result: Type.Unknown(),
  ackDelivered: Type.Optional(Type.Boolean()),
  code: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  handoff: Type.Optional(Type.Unknown()),
  restart: Type.Optional(Type.Unknown()),
  sentinel: Type.Optional(Type.Unknown()),
});

export type UpdateRunRecord = Static<typeof UpdateRunRecordSchema>;
export type UpdateRunsGetParams = Static<typeof UpdateRunsGetParamsSchema>;
export type UpdateRunsGetResult = Static<typeof UpdateRunsGetResultSchema>;
export type UpdateRunsListParams = Static<typeof UpdateRunsListParamsSchema>;
export type UpdateRunsListResult = Static<typeof UpdateRunsListResultSchema>;
export type UpdateRunChangedEvent = Static<typeof UpdateRunChangedEventSchema>;
export type UpdateRunResult = Static<typeof UpdateRunResultSchema>;
