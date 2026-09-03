/** Runtime decoding for durable update-generation transaction records. */
import { z } from "zod";
import {
  appendUpdateGenerationReceipt,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";

const generationIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonEmptyStringSchema = z.string().min(1);
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

const receiptBase = {
  formatVersion: z.literal(1),
  transactionId: nonEmptyStringSchema.regex(/^[A-Za-z0-9._:@/-]+$/u),
  sequence: nonNegativeIntegerSchema,
  receiptId: nonEmptyStringSchema,
  recordedAtMs: nonNegativeIntegerSchema,
};

export const updateGenerationTransactionReceiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...receiptBase,
      kind: z.literal("intent"),
      manager: z.enum(["npm", "pnpm", "bun"]),
      namespaceKey: nonEmptyStringSchema,
      namespaceRoot: nonEmptyStringSchema,
      selectorPath: nonEmptyStringSchema,
      stagingRoot: nonEmptyStringSchema,
      serviceBefore: serviceIntentSchema,
      previousSelection: updateGenerationSelectionSchema.nullable(),
      stableBindingAlreadyVerified: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("generation-materialization-intent"),
      role: z.enum(["previous", "candidate"]),
      sourceRoot: nonEmptyStringSchema,
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
    })
    .strict(),
  z
    .object({
      ...receiptBase,
      kind: z.literal("completion"),
      packageVersion: nonEmptyStringSchema,
      launcherVersion: nonEmptyStringSchema,
      serviceRunning: z.boolean(),
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

export const updateGenerationTransactionRecordSchema = z
  .object({
    formatVersion: z.literal(1),
    transactionId: nonEmptyStringSchema,
    namespaceKey: nonEmptyStringSchema,
    receipts: z.array(updateGenerationTransactionReceiptSchema).min(1),
  })
  .strict();

export function parseUpdateGenerationTransactionRecord(
  value: unknown,
): UpdateGenerationTransactionRecord {
  const decoded = updateGenerationTransactionRecordSchema.parse(value);
  let rebuilt: UpdateGenerationTransactionRecord | null = null;
  for (const decodedReceipt of decoded.receipts) {
    const receipt: UpdateGenerationTransactionReceipt = decodedReceipt;
    rebuilt = appendUpdateGenerationReceipt(rebuilt, receipt);
  }
  if (
    !rebuilt ||
    rebuilt.transactionId !== decoded.transactionId ||
    rebuilt.namespaceKey !== decoded.namespaceKey
  ) {
    throw new TypeError("Update generation transaction envelope disagrees with its receipts");
  }
  return rebuilt;
}
