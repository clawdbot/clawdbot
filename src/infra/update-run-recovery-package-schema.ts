import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  PackageRecoveryEffectSchema,
  PackageTransactionDescriptorSchema,
  type PackageRecoveryVerified,
  type PackageTransactionDescriptor,
} from "./package-update-recovery.js";

/** Private storage validation of the producer's typed facts, not evidence of live authority. */
const RecoveryPackageObservationSchema = z.strictObject({
  status: z.literal("verified"),
  descriptor: PackageTransactionDescriptorSchema,
  observation: z.strictObject({
    previous: z.enum(["live", "retained", "absent"]),
    candidate: z.enum(["live", "staged", "displaced", "absent"]),
    launchers: z.enum(["previous", "candidate", "both", "mixed", "interrupted"]),
    successorLive: z.boolean(),
  }),
  observedIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const RecoveryPackageStateSchema = z.strictObject({
  descriptor: PackageTransactionDescriptorSchema,
  observed: RecoveryPackageObservationSchema,
});
export const RecoveryPackageEffectSchema = z.strictObject({
  intent: PackageRecoveryEffectSchema,
  observed: RecoveryPackageObservationSchema.optional(),
  outcome: z.enum(["completed", "interrupted"]).optional(),
});

/** Mirrors the producer's identity calculation; callers must still obtain fresh owner observations. */
export function parseRecoveryPackageObservation(
  input: PackageRecoveryVerified,
): PackageRecoveryVerified {
  const value = RecoveryPackageObservationSchema.parse(input);
  const digest = createHash("sha256")
    .update(JSON.stringify([value.descriptor, value.observation]))
    .digest("hex");
  if (digest !== value.observedIdentity) {
    throw new Error("Package observation identity does not match its typed facts");
  }
  return value;
}

/** Only retention decisions and observed interrupted launchers may evolve. */
export function sameRecoveryPackage(
  left: PackageTransactionDescriptor,
  right: PackageTransactionDescriptor,
): boolean {
  const { retention: _leftRetention, interruptedLaunchers: _leftLaunchers, ...a } = left;
  const { retention: _rightRetention, interruptedLaunchers: _rightLaunchers, ...b } = right;
  return isDeepStrictEqual(a, b);
}
