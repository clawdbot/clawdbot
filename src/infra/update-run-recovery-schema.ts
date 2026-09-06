import path from "node:path";
import { z } from "zod";
import { UpdateServingReceiptSchema } from "./update-serving-verification-receipt.js";

const exactText = z.string().min(1).max(32_768);
const absolutePath = exactText.refine((value) => path.isAbsolute(value));
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runtime = z.strictObject({
  root: absolutePath,
  nodePath: absolutePath,
  version: exactText,
  buildId: exactText.nullable(),
});

const UpdateRecoveryEffectSchema = z
  .strictObject({
    effectId: z.uuid(),
    kind: z.enum([
      "package-activation",
      "checkpoint-restore",
      "package-restore",
      "service-restart",
      "retirement",
    ]),
    resourceId: exactText,
    runtime: z.enum(["candidate", "previous"]),
    state: z.enum(["intent", "observed"]),
    // Revalidated resource/lifecycle identity from its owner, never phase alone.
    observedIdentity: exactText.nullable(),
  })
  .refine((effect) => (effect.state === "observed") === (effect.observedIdentity !== null));

export const UpdateRecoveryRestoreProgressSchema = z
  .strictObject({
    restoreId: z.uuid(),
    checkpointId: z.uuid(),
    planPath: absolutePath,
    planSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    resourceCursor: counter,
    phase: z.enum(["preparing", "intent", "observed"]),
  })
  .refine((progress) => progress.phase === "preparing" || progress.planSha256 !== null);
export type UpdateRecoveryRestoreProgress = z.infer<typeof UpdateRecoveryRestoreProgressSchema>;

/** Private operational state, never passed through the redacted history codec. */
export const UpdateRecoveryRecordSchema = z.strictObject({
  runId: z.uuid(),
  transactionId: z.uuid(),
  revision: counter,
  claimId: z.uuid(),
  claimKind: z.enum(["initial", "recovery", "handoff"]),
  handoff: z
    .strictObject({
      handoffId: z.uuid(),
      state: z.enum(["prepared", "accepted"]),
    })
    .nullable(),
  from: runtime,
  to: runtime,
  createdAtMs: counter,
  updatedAtMs: counter,
  effects: z.array(UpdateRecoveryEffectSchema).max(4096),
  restore: UpdateRecoveryRestoreProgressSchema.nullable().default(null),
  verification: z
    .strictObject({
      runtime: z.enum(["candidate", "previous"]),
      effectId: z.uuid(),
      receipt: UpdateServingReceiptSchema,
    })
    .nullable(),
  primaryFailure: z.strictObject({ code: exactText, effectId: z.uuid().nullable() }).nullable(),
});
export type UpdateRecoveryRecord = z.infer<typeof UpdateRecoveryRecordSchema>;
export type UpdateRecoveryEffect = z.infer<typeof UpdateRecoveryEffectSchema>;
