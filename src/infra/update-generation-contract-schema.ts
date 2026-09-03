/** Runtime decoding for durable update-generation transaction records. */
import { z } from "zod";
import {
  assertUpdateGenerationBrokerReceiptIsValid,
  type UpdateGenerationBrokerReceipt,
} from "./update-generation-confined-filesystem.js";
const generationIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonEmptyStringSchema = z.string().min(1);
const nonBlankStringSchema = z.string().refine((value) => value.trim().length > 0);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const relativeEntrypointSchema = nonEmptyStringSchema.refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return (
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//u.test(normalized) &&
    normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
});

const manifestSchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: sha256Schema,
    entryCount: nonNegativeIntegerSchema,
    totalBytes: nonNegativeIntegerSchema,
  })
  .strict();

export const updateGenerationSelectionSchema = z
  .object({
    formatVersion: z.literal(1),
    generationId: generationIdSchema,
    manifestSha256: sha256Schema,
    entrypointRelativePath: relativeEntrypointSchema,
  })
  .strict();

const descriptorSchema = updateGenerationSelectionSchema
  .extend({ packageVersion: nonEmptyStringSchema })
  .strict();
const serviceIntentSchema = z
  .object({
    managed: z.boolean(),
    running: z.boolean(),
    enabled: z.boolean().optional(),
  })
  .strict();
const bindingSchema = z
  .object({
    kind: z.enum(["launcher", "service"]),
    identity: nonEmptyStringSchema,
    priorFingerprint: z.string().nullable(),
  })
  .strict();
const completedBindingSchema = bindingSchema.extend({ fingerprint: nonEmptyStringSchema }).strict();
const deferredCleanupSchema = z
  .object({ generationId: generationIdSchema, reason: nonEmptyStringSchema })
  .strict();

const brokerReceiptSchema = z.custom<UpdateGenerationBrokerReceipt>((value) => {
  try {
    assertUpdateGenerationBrokerReceiptIsValid(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid authenticated update broker receipt envelope");

function brokerReceiptOf<Kind extends UpdateGenerationBrokerReceipt["kind"]>(kind: Kind) {
  return brokerReceiptSchema.refine(
    (receipt): receipt is Extract<UpdateGenerationBrokerReceipt, { kind: Kind }> =>
      receipt.kind === kind,
    `Expected ${kind} broker receipt`,
  );
}

const materializationEvidenceSchema = z
  .object({
    materialization: brokerReceiptOf("materialize-generation"),
    parentDirectorySync: brokerReceiptOf("sync-parent-directory"),
  })
  .strict();
const selectionEvidenceSchema = z
  .object({
    selectorSwitch: brokerReceiptOf("switch-selector"),
    parentDirectorySync: brokerReceiptOf("sync-parent-directory"),
  })
  .strict();
const retainedPairEvidenceSchema = z
  .object({
    retainedPair: brokerReceiptOf("verify-retained-pair"),
    recoveryObservation: brokerReceiptOf("observe-recovery"),
  })
  .strict();
const selectedEvidenceSchema = selectionEvidenceSchema
  .extend(retainedPairEvidenceSchema.shape)
  .strict();
const cleanupEvidenceSchema = z
  .object({
    cleanup: brokerReceiptOf("cleanup-generations"),
    parentDirectorySync: brokerReceiptOf("sync-parent-directory"),
    retainedPair: brokerReceiptOf("verify-retained-pair"),
    recoveryObservation: brokerReceiptOf("observe-recovery"),
  })
  .strict();

const receiptBase = {
  formatVersion: z.literal(2),
  transactionId: nonEmptyStringSchema.regex(/^[A-Za-z0-9._:@/-]+$/u),
  sequence: nonNegativeIntegerSchema,
  receiptId: nonEmptyStringSchema,
  recordedAtMs: nonNegativeIntegerSchema,
};

const updateGenerationTransactionReceiptUnion = z.discriminatedUnion("kind", [
  z
    .object({
      ...receiptBase,
      kind: z.literal("intent"),
      namespaceKey: nonEmptyStringSchema,
      serviceBefore: serviceIntentSchema,
      previousSelection: updateGenerationSelectionSchema.nullable(),
      previousPackageVersion: nonEmptyStringSchema.nullable(),
      stableBindingAlreadyVerified: z.boolean(),
      brokerId: nonBlankStringSchema,
      brokerRevision: nonBlankStringSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("generation-materialization-intent"),
      role: z.enum(["previous", "candidate"]),
      sourceArtifactId: nonEmptyStringSchema,
      generationId: generationIdSchema,
      manifest: manifestSchema,
      packageVersion: nonEmptyStringSchema,
      entrypointRelativePath: relativeEntrypointSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("generation-materialized"),
      role: z.enum(["previous", "candidate"]),
      generation: descriptorSchema,
      evidence: materializationEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("baseline-selection-intent"),
      selection: updateGenerationSelectionSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("baseline-selected"),
      selection: updateGenerationSelectionSchema,
      evidence: selectionEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("binding-intent"),
      bindings: z.array(bindingSchema),
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("binding-completed"),
      bindings: z.array(completedBindingSchema),
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("candidate-selection-intent"),
      from: updateGenerationSelectionSchema,
      to: updateGenerationSelectionSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("candidate-selected"),
      selection: updateGenerationSelectionSchema,
      evidence: selectedEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("completion"),
      packageVersion: nonEmptyStringSchema,
      launcherVersion: nonEmptyStringSchema,
      serviceRunning: z.boolean(),
      serviceEnabled: z.boolean().optional(),
      evidence: retainedPairEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("rollback-intent"),
      from: updateGenerationSelectionSchema,
      to: updateGenerationSelectionSchema,
      reason: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("rolled-back"),
      selection: updateGenerationSelectionSchema,
      launcherVersion: nonEmptyStringSchema,
      serviceRunning: z.boolean(),
      serviceEnabled: z.boolean().optional(),
      evidence: selectedEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("cleanup-intent"),
      generationIds: z.array(generationIdSchema),
      protectedGenerationIds: z.array(generationIdSchema),
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("cleanup-completed"),
      removedGenerationIds: z.array(generationIdSchema),
      deferred: z.array(deferredCleanupSchema),
      evidence: cleanupEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("failure"),
      operation: nonEmptyStringSchema,
      reason: nonEmptyStringSchema,
      serviceRestored: z.boolean(),
    })
    .strict(),
]);

export const updateGenerationTransactionReceiptSchema =
  updateGenerationTransactionReceiptUnion.superRefine((receipt, context) => {
    if (receipt.kind !== "intent") {
      return;
    }
    if (Boolean(receipt.previousSelection) !== Boolean(receipt.previousPackageVersion)) {
      context.addIssue({
        code: "custom",
        path: ["previousPackageVersion"],
        message: "Previous generation selection and package version must be recorded together",
      });
    }
    if (receipt.stableBindingAlreadyVerified && !receipt.previousSelection) {
      context.addIssue({
        code: "custom",
        path: ["previousSelection"],
        message: "A verified stable binding requires a previous generation selection",
      });
    }
    if (receipt.previousSelection && !receipt.stableBindingAlreadyVerified) {
      context.addIssue({
        code: "custom",
        path: ["stableBindingAlreadyVerified"],
        message: "An existing generation selection requires a verified stable binding",
      });
    }
  });

export const updateGenerationTransactionRecordSchema = z
  .object({
    formatVersion: z.literal(2),
    transactionId: nonEmptyStringSchema,
    namespaceKey: nonEmptyStringSchema,
    receipts: z.array(updateGenerationTransactionReceiptSchema).min(1),
  })
  .strict();
