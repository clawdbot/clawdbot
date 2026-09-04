import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import {
  UPDATE_RUN_PHASES,
  UPDATE_RUN_STATUSES,
  UPDATE_RUN_STEP_STATUSES,
  UPDATE_RUN_TRIGGERS,
} from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import type { UpdateStepResult } from "./update-runner-types.js";

/** A bounded diagnostic excerpt for a failed update step, never its command log or cwd. */
export function summarizeUpdateStepFailure(
  step: Pick<UpdateStepResult, "exitCode" | "termination" | "stdoutTail" | "stderrTail">,
): string {
  return truncateUtf16Safe(
    [
      step.termination ?? `Exit code: ${step.exitCode ?? "unknown"}`,
      ...[step.stdoutTail, step.stderrTail].map((tail) =>
        sliceUtf16Safe(tail?.trim().split(/\r?\n/u).at(-1) ?? "", -120),
      ),
    ]
      .filter(Boolean)
      .join("; "),
    300,
  );
}

const text = z.string().max(1024);
const timestamp = z.number().int().nonnegative();
const version = z.object({
  version: text.nullable().optional(),
  sha: text.nullable().optional(),
  buildId: text.nullable().optional(),
});

const UpdateRunStepSchema = z.object({
  step: text,
  status: z.enum(UPDATE_RUN_STEP_STATUSES),
  startedAtMs: timestamp.optional(),
  endedAtMs: timestamp.optional(),
  detail: text.optional(),
});

export const UpdateRunRecordSchema = z.object({
  runId: z.uuid(),
  createdAtMs: timestamp,
  updatedAtMs: timestamp,
  trigger: z.enum(UPDATE_RUN_TRIGGERS),
  phase: z.enum(UPDATE_RUN_PHASES),
  status: z.enum(UPDATE_RUN_STATUSES),
  reason: text.nullable(),
  origin: z.object({
    requester: z
      .object({ channel: text.optional(), accountId: text.optional(), senderId: text.optional() })
      .optional(),
    sessionKey: text.optional(),
    deliveryContext: z
      .object({
        channel: text.optional(),
        to: text.optional(),
        accountId: text.optional(),
        threadId: text.optional(),
      })
      .optional(),
    campaignId: text.optional(),
    doctorHint: text.optional(),
    nextAction: text.optional(),
  }),
  target: z.object({
    channel: text.optional(),
    tag: text.optional(),
    kind: z.enum(["package", "git"]).optional(),
    version: text.optional(),
    sha: text.optional(),
  }),
  before: version,
  after: version,
  steps: z.array(UpdateRunStepSchema).max(128),
  verification: z.object({
    booted: z.boolean().optional(),
    runningVersion: text.optional(),
    runningBuildId: text.optional(),
    serviceRunning: z.boolean().optional(),
    pid: timestamp.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    versionMatch: z.boolean().optional(),
    pluginErrors: z.array(text).max(32).optional(),
    channelsReady: z.boolean().optional(),
    inferenceProbe: z.enum(["passed", "failed", "skipped"]).optional(),
    noticeDelivered: z.boolean().optional(),
    doctorHint: text.optional(),
  }),
  repair: z
    .array(
      z.object({
        attempt: z.number().int().positive(),
        status: z.enum(["succeeded", "failed", "skipped"]),
        startedAtMs: timestamp,
        endedAtMs: timestamp.optional(),
        summary: text.optional(),
        reason: text.optional(),
      }),
    )
    .max(16),
  confirmedAtMs: timestamp.nullable(),
  finishedAtMs: timestamp.nullable(),
  downtimeMs: timestamp.nullable(),
});

export type UpdateRunRecord = z.infer<typeof UpdateRunRecordSchema>;
export type UpdateRunPhase = UpdateRunRecord["phase"];
export type UpdateRunStep = UpdateRunRecord["steps"][number];
