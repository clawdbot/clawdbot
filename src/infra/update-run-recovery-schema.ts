import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  RecoveryNativeManagerSchema,
  isRecoverablePreparationNative,
  currentUpdateRecoveryNativeFacts,
} from "./update-run-recovery-native-schema.js";
import {
  RecoveryPackageStateSchema,
  RecoveryPackageEffectSchema,
} from "./update-run-recovery-package-schema.js";

const exactText = z.string().min(1).max(32_768);
const absolutePath = exactText.refine((value) => path.isAbsolute(value));
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runtime = z.strictObject({
  root: absolutePath,
  nodePath: absolutePath,
  version: exactText,
  buildId: exactText.nullable(),
});

/** Observed readiness facts only. The producer must preserve its original recovery
 * claim/revision across awaited health and HTTP probes. No serialized authority.
 * Deliberately no legacy transform: transcript receipts cannot establish readiness,
 * and rewriting them during read would also invalidate publication commitments.
 */
export const UpdateRecoveryReadinessReceiptSchema = z.strictObject({
  kind: z.literal("readiness", {
    error:
      "Legacy update verification is not readiness evidence; explicit reconciliation is required.",
  }),
  runId: z.uuid(),
  transactionId: z.uuid(),
  claimId: z.uuid(),
  revision: counter,
  effectId: z.uuid(),
  runtime: z.enum(["candidate", "previous"]),
  gateway: z.strictObject({
    bootId: z.string().min(1).max(96),
    version: z.string().min(1).max(256),
    buildId: z.string().min(1).max(256).nullable(),
  }),
  checks: z.strictObject({
    serviceRunning: z.literal(true),
    pluginsReady: z.literal(true),
    channelsReady: z.literal(true),
    settled: z.literal(true),
    readyz: z.literal(true),
  }),
  verifiedAtMs: counter,
});
export type UpdateRecoveryReadinessReceipt = z.infer<typeof UpdateRecoveryReadinessReceiptSchema>;

const UpdateRecoveryEffectSchema = z
  .strictObject({
    effectId: z.uuid(),
    kind: z.enum([
      "package-activation",
      "runtime-mutation",
      "checkpoint-restore",
      "package-restore",
      "service-restart",
      "retirement",
    ]),
    resourceId: exactText,
    runtime: z.enum(["candidate", "previous"]),
    state: z.enum(["intent", "observed", "cancelled"]),
    cancelledByNativeEffectId: z.uuid().optional(),
    package: RecoveryPackageEffectSchema.optional(),
    // Revalidated resource/lifecycle identity from its owner, never phase alone.
    observedIdentity: exactText.nullable(),
  })
  .refine(
    (effect) =>
      (effect.state === "observed") === (effect.observedIdentity !== null) &&
      (effect.state === "cancelled"
        ? effect.kind === "service-restart" &&
          !effect.package &&
          effect.cancelledByNativeEffectId !== undefined
        : effect.cancelledByNativeEffectId === undefined),
  );

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
const checkpointRef = z.strictObject({
  checkpointId: z.uuid(),
  manifestPath: absolutePath,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const checkpoint = z.strictObject({
  ref: checkpointRef,
  // Full checkpoints assembled from separately bound early files retain their locator.
  preimageRef: checkpointRef.optional(),
  binding: z.strictObject({
    runId: z.uuid(),
    stateDir: absolutePath,
    configPath: absolutePath,
    fromRuntime: runtime.omit({ buildId: true }),
  }),
});

const afterImage = z.strictObject({
  checkpointRef,
  afterUpdate: checkpoint,
  effectIds: z.array(z.uuid()).min(1).max(4096),
  boundAtRevision: counter,
});
export type UpdateRecoveryAfterImage = z.infer<typeof afterImage>;

// Decode-only compatibility for receipts persisted before readiness replaced model
// probes. This is the exact retired storage shape, not an inference producer or a
// conversion to current evidence. Keep it private to the inspection schema.
const legacyIdentifier = z.string().min(1).max(256);
const legacyAnchor = z.strictObject({ entryId: legacyIdentifier, seq: counter });
const legacyServingReceipt = z
  .strictObject({
    runId: z.uuid(),
    gateway: UpdateRecoveryReadinessReceiptSchema.shape.gateway,
    agentId: legacyIdentifier,
    sessionKey: z.string().min(1).max(512),
    sessionId: legacyIdentifier,
    agentRunId: z.uuid(),
    transcript: z.strictObject({
      generation: legacyIdentifier,
      maxSeq: counter,
      user: legacyAnchor,
      assistant: legacyAnchor,
    }),
    verifiedAtMs: counter,
  })
  .refine(
    (receipt) =>
      receipt.transcript.user.seq < receipt.transcript.assistant.seq &&
      receipt.transcript.assistant.seq <= receipt.transcript.maxSeq,
    { message: "Invalid legacy serving transcript sequence" },
  );
const inspectionReceipt = z.union([UpdateRecoveryReadinessReceiptSchema, legacyServingReceipt]);

/** Private operational state, never passed through the redacted history codec. */
const recoveryInspectionRecordSchema = z
  .strictObject({
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
    source: z
      .strictObject({
        stateDir: absolutePath,
        configPath: absolutePath,
        profile: exactText.nullable().optional(),
      })
      .optional(),
    from: runtime,
    to: runtime,
    createdAtMs: counter,
    updatedAtMs: counter,
    effects: z.array(UpdateRecoveryEffectSchema).max(4096),
    // File-only original bytes/absence; never a substitute for the post-stop checkpoint.
    preimages: checkpoint
      .omit({ preimageRef: true })
      .extend({ boundAtRevision: counter })
      .optional(),
    nativeManager: RecoveryNativeManagerSchema.optional(),
    checkpoint: checkpoint.optional(),
    // Append-only owner-reopened after-images. No defaults: preserve existing
    // publication commitments for records written before this facility existed.
    afterImages: z.array(afterImage).max(4096).optional(),
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
        receipt: inspectionReceipt,
      })
      .nullable(),
    package: RecoveryPackageStateSchema.optional(),
    terminal: z
      .strictObject({
        status: z.enum(["succeeded", "rolled-back"]),
        committedAtMs: counter,
        commitRevision: counter,
        receipt: inspectionReceipt,
        pairId: z.uuid().nullable(),
      })
      .optional(),
    // Historical pre-package settlement (native state may have been restored),
    // not a serving or database rollback receipt.
    preparationAborted: z
      .strictObject({
        reason: z.literal("interrupted-preparation"),
        committedAtMs: counter,
        commitRevision: counter,
        observedIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .optional(),
    retainedPair: z
      .strictObject({
        pairId: z.uuid(),
        state: z.enum(["selected", "superseded"]),
        replacementRunId: z.uuid().optional(),
      })
      .optional(),
    primaryFailure: z.strictObject({ code: exactText, effectId: z.uuid().nullable() }).nullable(),
  })
  .superRefine((record, ctx) => {
    const aborted = record.preparationAborted;
    if (
      aborted &&
      (!record.source ||
        !record.preimages ||
        !record.nativeManager ||
        !record.package ||
        record.claimKind !== "recovery" ||
        record.effects.length !== 0 ||
        !isRecoverablePreparationNative(record.nativeManager, true) ||
        record.handoff ||
        record.checkpoint ||
        record.afterImages !== undefined ||
        record.restore ||
        record.publication ||
        record.verification ||
        record.terminal ||
        record.retainedPair ||
        record.primaryFailure?.code !== aborted.reason ||
        record.primaryFailure.effectId !== null ||
        aborted.commitRevision !== record.revision ||
        aborted.committedAtMs > record.updatedAtMs ||
        aborted.observedIdentity !== record.package.observed.observedIdentity ||
        record.package.descriptor.retention !== null ||
        record.package.descriptor.interruptedLaunchers.length !== 0 ||
        record.package.observed.observation.previous !== "live" ||
        record.package.observed.observation.candidate !== "staged" ||
        !["previous", "both"].includes(record.package.observed.observation.launchers) ||
        record.package.observed.observation.successorLive)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Preparation settlement cannot carry effects or serving authority",
      });
    }
    const verification = record.verification;
    if (verification) {
      const receipt = verification.receipt;
      const identity = verification.runtime === "candidate" ? record.to : record.from;
      const restart = record.effects.find((effect) => effect.effectId === verification.effectId);
      if (
        receipt.runId !== record.runId ||
        ("kind" in receipt &&
          (receipt.transactionId !== record.transactionId ||
            receipt.claimId !== record.claimId ||
            receipt.revision >= record.revision ||
            receipt.runtime !== verification.runtime ||
            receipt.effectId !== verification.effectId)) ||
        receipt.gateway.version !== identity.version ||
        receipt.gateway.buildId !== identity.buildId ||
        restart?.kind !== "service-restart" ||
        restart.state !== "observed" ||
        restart.runtime !== verification.runtime ||
        restart.observedIdentity !== receipt.gateway.bootId ||
        (!record.terminal && restart !== record.effects.at(-1))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Verification evidence does not match recovery and restart",
        });
      }
    }
    if (
      verification &&
      record.terminal &&
      !isDeepStrictEqual(verification.receipt, record.terminal.receipt)
    ) {
      ctx.addIssue({ code: "custom", message: "Terminal and verification receipts differ" });
    }
    const native = record.nativeManager;
    const nativeFinal = native ? currentUpdateRecoveryNativeFacts(native) : undefined;
    if (
      native &&
      (!record.preimages ||
        !record.source ||
        native.identity.runId !== record.runId ||
        native.identity.stateDir !== record.source.stateDir ||
        native.identity.configPath !== record.source.configPath ||
        native.identity.profile !== record.source.profile ||
        native.boundAtRevision > record.revision ||
        (!record.primaryFailure && native.effects.some((entry) => entry.state === "not-applied")) ||
        native.effects.some(
          (entry) => (entry.observedRevision ?? entry.intentRevision) > record.revision,
        ) ||
        (native.effects.at(-1)?.state === "intent" && (record.terminal || record.verification)) ||
        (!nativeFinal?.stopped &&
          record.effects.some(
            (effect) =>
              effect.state === "intent" &&
              (effect.kind === "package-activation" ||
                effect.kind === "runtime-mutation" ||
                effect.kind === "package-restore" ||
                effect.kind === "checkpoint-restore"),
          )) ||
        (record.terminal &&
          nativeFinal &&
          (nativeFinal.exists !== native.original.exists ||
            nativeFinal.enabled !== native.original.enabled ||
            nativeFinal.loaded !== native.original.loaded ||
            nativeFinal.stopped !== native.original.stopped)))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Native manager evidence must match admitted source and revision",
      });
    }
    const early = record.preimages;
    if (
      (early &&
        (early.boundAtRevision > record.revision ||
          !record.source ||
          early.binding.runId !== record.runId ||
          early.binding.stateDir !== record.source.stateDir ||
          early.binding.configPath !== record.source.configPath ||
          early.binding.fromRuntime.root !== record.from.root ||
          early.binding.fromRuntime.nodePath !== record.from.nodePath ||
          early.binding.fromRuntime.version !== record.from.version)) ||
      (record.checkpoint &&
        ((early &&
          (!isDeepStrictEqual(record.checkpoint.preimageRef, early.ref) ||
            !isDeepStrictEqual(record.checkpoint.binding, early.binding) ||
            record.checkpoint.ref.checkpointId === early.ref.checkpointId ||
            record.checkpoint.ref.manifestPath === early.ref.manifestPath ||
            record.checkpoint.ref.manifestSha256 === early.ref.manifestSha256)) ||
          (!early && record.checkpoint.preimageRef)))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Early file preimages must remain distinct from the full checkpoint",
      });
    }
    if (record.package && record.package.descriptor.transactionId !== record.transactionId) {
      ctx.addIssue({ code: "custom", message: "Package transaction differs from recovery" });
    }
    for (const effect of record.effects) {
      if (effect.state === "cancelled") {
        const startIndex =
          native?.effects.findIndex((entry) => entry.effectId === effect.effectId) ?? -1;
        const stopIndex =
          native?.effects.findIndex(
            (entry) => entry.effectId === effect.cancelledByNativeEffectId,
          ) ?? -1;
        const start = native?.effects[startIndex];
        const stopped = native?.effects[stopIndex];
        const cancelledBeforeStart =
          stopIndex === startIndex && stopped?.state === "not-applied" && stopped.before.stopped;
        const stoppedAfterStart =
          stopIndex > startIndex &&
          stopped?.action === "stop" &&
          stopped.state === "observed" &&
          stopped.after.stopped;
        if (
          !record.primaryFailure ||
          !start ||
          start.action !== "restore" ||
          !start.before.stopped ||
          start.after.stopped ||
          !(cancelledBeforeStart || stoppedAfterStart)
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Cancelled restart requires resolved native quiescence",
          });
        }
      }
      if (
        effect.package &&
        (effect.package.intent.effectId !== effect.effectId ||
          effect.package.intent.descriptor.transactionId !== record.transactionId ||
          (effect.state === "observed") !==
            Boolean(effect.package.observed && effect.package.outcome) ||
          (effect.package.observed &&
            effect.observedIdentity !== effect.package.observed.observedIdentity))
      ) {
        ctx.addIssue({ code: "custom", message: "Invalid typed package effect" });
      }
    }
    if (
      record.terminal &&
      (record.terminal.commitRevision > record.revision ||
        record.terminal.receipt.runId !== record.runId ||
        record.terminal.pairId !== (record.retainedPair?.pairId ?? null))
    ) {
      ctx.addIssue({ code: "custom", message: "Terminal outcome and selected pair differ" });
    }
    if (record.terminal && "kind" in record.terminal.receipt) {
      const receipt = record.terminal.receipt;
      const role = record.terminal.status === "succeeded" ? "candidate" : "previous";
      const identity = role === "candidate" ? record.to : record.from;
      const restart = record.effects.find((effect) => effect.effectId === receipt.effectId);
      if (
        receipt.transactionId !== record.transactionId ||
        receipt.runtime !== role ||
        receipt.revision + 2 !== record.terminal.commitRevision ||
        receipt.gateway.version !== identity.version ||
        receipt.gateway.buildId !== identity.buildId ||
        restart?.kind !== "service-restart" ||
        restart.state !== "observed" ||
        restart.runtime !== role ||
        restart.observedIdentity !== receipt.gateway.bootId ||
        (verification && !isDeepStrictEqual(verification.receipt, receipt))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Terminal readiness does not match its recorded restart",
        });
      }
    }
    if (record.terminal && !("kind" in record.terminal.receipt)) {
      // Legacy receipts have no effect/claim fields. Validate against the stored
      // final restart, without manufacturing the missing readiness bindings.
      const receipt = record.terminal.receipt;
      const role = record.terminal.status === "succeeded" ? "candidate" : "previous";
      const identity = role === "candidate" ? record.to : record.from;
      const restart = record.effects.findLast((effect) => effect.kind === "service-restart");
      if (
        (verification &&
          (verification.runtime !== role || verification.effectId !== restart?.effectId)) ||
        receipt.gateway.version !== identity.version ||
        receipt.gateway.buildId !== identity.buildId ||
        restart?.state !== "observed" ||
        restart.runtime !== role ||
        restart.observedIdentity !== receipt.gateway.bootId
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Legacy terminal evidence differs from its recorded restart",
        });
      }
    }
    const pair = record.retainedPair;
    const retention = record.package?.descriptor.retention;
    if (
      (pair &&
        (!record.terminal ||
          record.terminal.status !== "succeeded" ||
          !retention ||
          retention.state === "unselected" ||
          retention.state !== pair.state ||
          retention.pairId !== pair.pairId ||
          (pair.state === "superseded") !== Boolean(pair.replacementRunId))) ||
      (record.terminal?.status === "succeeded" && !pair) ||
      (record.terminal?.status === "rolled-back" && (pair || retention?.state !== "unselected"))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Recovery selection does not match committed package roles",
      });
    }
    let cursor = 0;
    let revision = -1;
    const refs = record.checkpoint ? [record.checkpoint.ref] : [];
    for (const [index, image] of (record.afterImages ?? []).entries()) {
      const effects = record.effects.slice(cursor, cursor + image.effectIds.length);
      if (
        !record.checkpoint ||
        !isDeepStrictEqual(image.checkpointRef, record.checkpoint.ref) ||
        !isDeepStrictEqual(image.afterUpdate.binding, record.checkpoint.binding) ||
        image.boundAtRevision <= revision ||
        image.boundAtRevision > record.revision ||
        !isDeepStrictEqual(
          image.effectIds,
          effects.map((effect) => effect.effectId),
        ) ||
        effects.some(
          (effect) =>
            effect.state !== "observed" ||
            effect.package?.outcome === "interrupted" ||
            effect.runtime !== "candidate" ||
            effect.kind === "checkpoint-restore" ||
            effect.kind === "package-restore" ||
            effect.kind === "retirement",
        ) ||
        refs.some(
          (ref) =>
            ref.checkpointId === image.afterUpdate.ref.checkpointId ||
            ref.manifestPath === image.afterUpdate.ref.manifestPath ||
            ref.manifestSha256 === image.afterUpdate.ref.manifestSha256,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["afterImages", index],
          message:
            "After-image must bind a distinct checkpoint to the exact completed mutation interval",
        });
      }
      cursor += image.effectIds.length;
      revision = image.boundAtRevision;
      refs.push(image.afterUpdate.ref);
    }
  });
/** Execution/mutation decoding remains readiness-only. The inspection shape is
 * intentionally wider, so an inspected legacy row is not a mutation input. */
export const UpdateRecoveryRecordSchema = recoveryInspectionRecordSchema.safeExtend({
  verification: recoveryInspectionRecordSchema.shape.verification
    .unwrap()
    .extend({
      receipt: UpdateRecoveryReadinessReceiptSchema,
    })
    .nullable(),
  terminal: recoveryInspectionRecordSchema.shape.terminal
    .unwrap()
    .extend({
      receipt: UpdateRecoveryReadinessReceiptSchema,
    })
    .optional(),
});
export type UpdateRecoveryRecord = z.infer<typeof UpdateRecoveryRecordSchema>;
export type UpdateRecoveryInspection = {
  readonly format: "current" | "legacy-serving";
  /** Exact retained bytes; never serialize the parsed view back over the source. */
  readonly raw: string;
  readonly record: z.infer<typeof recoveryInspectionRecordSchema>;
};

/** Read-only historical inspection. Unknown/corrupt rows fail, never disappear.
 * No migration, receipt upgrade, claim acquisition, or mutation eligibility. */
export function inspectUpdateRecovery(raw: string, runId: string): UpdateRecoveryInspection {
  if (Buffer.byteLength(raw) > MAX_RECOVERY_BYTES) {
    throw new Error("Update recovery record exceeds its storage limit");
  }
  const record = recoveryInspectionRecordSchema.parse(JSON.parse(raw));
  if (record.runId !== runId) {
    throw new Error("Update recovery record does not match its history run");
  }
  const receipts = [record.verification?.receipt, record.terminal?.receipt];
  return {
    format: receipts.some((receipt) => receipt && !("kind" in receipt))
      ? "legacy-serving"
      : "current",
    raw,
    record,
  };
}

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
  if (record.nativeManager && !currentUpdateRecoveryNativeFacts(record.nativeManager).stopped) {
    throw new Error("Full checkpoint binding requires an observed native stop");
  }
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

const MAX_RECOVERY_BYTES = 1024 * 1024;

export function decodeUpdateRecovery(raw: string, runId: string): UpdateRecoveryRecord {
  if (Buffer.byteLength(raw) > MAX_RECOVERY_BYTES) {
    throw new Error("Update recovery record exceeds its storage limit");
  }
  const record = UpdateRecoveryRecordSchema.parse(JSON.parse(raw));
  if (record.runId !== runId) {
    throw new Error("Update recovery record does not match its history run");
  }
  return record;
}
export function encodeUpdateRecovery(record: UpdateRecoveryRecord): string {
  const raw = JSON.stringify(UpdateRecoveryRecordSchema.parse(record));
  if (Buffer.byteLength(raw) > MAX_RECOVERY_BYTES) {
    throw new Error("Update recovery record exceeds its storage limit");
  }
  return raw;
}

/** Only decoded records may be tested: an aborted preparation is historical,
 * and can never confer restart, cleanup, or future claim authority. */
export function isUpdateRecoveryPending(record: {
  terminal?: unknown;
  preparationAborted?: unknown;
  effects: readonly { state: string }[];
}): boolean {
  return (
    !record.preparationAborted &&
    (!record.terminal || record.effects.some((effect) => effect.state === "intent"))
  );
}
