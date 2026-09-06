import { createHash } from "node:crypto";
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

/** Exact storage projection of the checkpoint owner's ref and manifest binding.
 * Artifact verification stays with reopenUpdateCheckpoint; these facts grant no authority.
 */
const checkpoint = z.strictObject({
  ref: z.strictObject({
    checkpointId: z.uuid(),
    manifestPath: absolutePath,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  binding: z.strictObject({
    runId: z.uuid(),
    stateDir: absolutePath,
    configPath: absolutePath,
    fromRuntime: runtime.omit({ buildId: true }),
  }),
});

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
  // Captured at admission, before config/service mutation. Missing legacy facts
  // cannot be inferred from a later checkpoint reference.
  source: z.strictObject({ stateDir: absolutePath, configPath: absolutePath }).optional(),
  from: runtime,
  to: runtime,
  createdAtMs: counter,
  updatedAtMs: counter,
  effects: z.array(UpdateRecoveryEffectSchema).max(4096),
  checkpoint: checkpoint.optional(),
  restore: UpdateRecoveryRestoreProgressSchema.nullable().default(null),
  // Sealed in BOTH copies before publication; later live-only writes preserve it.
  // Hash of the canonical publication row except this self-referential field.
  publication: z
    .strictObject({
      revision: counter,
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .optional(),
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

export class UpdateRecoveryConflictError extends Error {
  constructor() {
    super("Update recovery changed; reload and reconcile before continuing.");
    this.name = "UpdateRecoveryConflictError";
  }
}
export class UpdateRecoveryRequiredError extends Error {
  constructor(readonly record: UpdateRecoveryRecord) {
    super(
      `Update ${record.runId} has unfinished recovery; reconcile it before starting another update.`,
    );
    this.name = "UpdateRecoveryRequiredError";
  }
}

/** Pure validation of checkpoint facts before the owning fenced transaction persists them. */
export function parseUpdateRecoveryCheckpoint(
  record: UpdateRecoveryRecord,
  input: NonNullable<UpdateRecoveryRecord["checkpoint"]>,
): NonNullable<UpdateRecoveryRecord["checkpoint"]> {
  const captured = checkpoint.parse(input);
  const { binding } = captured;
  if (
    record.effects.length !== 0 ||
    !record.source ||
    binding.stateDir !== record.source.stateDir ||
    binding.configPath !== record.source.configPath ||
    binding.runId !== record.runId ||
    binding.fromRuntime.root !== record.from.root ||
    binding.fromRuntime.nodePath !== record.from.nodePath ||
    binding.fromRuntime.version !== record.from.version
  ) {
    throw new Error("Checkpoint binding must match the admitted source before update effects");
  }
  if (record.checkpoint && JSON.stringify(record.checkpoint) !== JSON.stringify(captured)) {
    throw new UpdateRecoveryConflictError();
  }
  return captured;
}

/** Canonical complete publication preimage; the commitment field alone is omitted. */
function publicationDigest(record: UpdateRecoveryRecord): string {
  const parsed = UpdateRecoveryRecordSchema.parse(record);
  delete parsed.publication;
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

/** Called only inside fenced carry-forward, after revision/time and sealed plan are fixed. */
export function sealUpdateRecoveryPublication(record: UpdateRecoveryRecord): void {
  if (record.restore?.phase === "intent") {
    record.publication = { revision: record.revision, sha256: publicationDigest(record) };
  }
}

/** A prior row is evidence only if it matches the commitment retained by current recovery. */
export function assertUpdateRecoveryPublicationRecord(
  current: UpdateRecoveryRecord,
  prior: UpdateRecoveryRecord,
): void {
  const anchor = current.publication;
  const restore = prior.restore;
  if (
    !anchor ||
    !prior.publication ||
    !restore ||
    restore.phase !== "intent" ||
    !restore.planSha256 ||
    current.runId !== prior.runId ||
    current.transactionId !== prior.transactionId ||
    current.revision < prior.revision ||
    anchor.revision !== prior.revision ||
    prior.publication.revision !== anchor.revision ||
    prior.publication.sha256 !== anchor.sha256 ||
    publicationDigest(prior) !== anchor.sha256 ||
    current.restore?.restoreId !== restore.restoreId ||
    current.restore.checkpointId !== restore.checkpointId ||
    current.restore.planPath !== restore.planPath ||
    current.restore.planSha256 !== restore.planSha256 ||
    current.restore.resourceCursor < restore.resourceCursor
  ) {
    throw new UpdateRecoveryConflictError();
  }
}
