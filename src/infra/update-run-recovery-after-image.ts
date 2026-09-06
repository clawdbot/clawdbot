import { isDeepStrictEqual } from "node:util";
import {
  UpdateRecoveryConflictError,
  UpdateRecoveryRecordSchema,
  type UpdateRecoveryAfterImage,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";

/** Pure append validation; the recovery owner calls this inside its fenced CAS. */
export function appendUpdateRecoveryAfterImage(
  record: UpdateRecoveryRecord,
  input: Omit<UpdateRecoveryAfterImage, "boundAtRevision">,
): void {
  const previous = record.afterImages ?? [];
  const covered = previous.reduce((count, image) => count + image.effectIds.length, 0);
  const interval = record.effects.slice(covered);
  if (
    record.restore ||
    !interval.length ||
    !isDeepStrictEqual(
      input.effectIds,
      interval.map((effect) => effect.effectId),
    )
  ) {
    throw new UpdateRecoveryConflictError();
  }
  // Validate the entire append, including initial source binding and observations,
  // before changing the transaction record. The writer increments this revision.
  const parsed = UpdateRecoveryRecordSchema.parse({
    ...record,
    revision: record.revision + 1,
    afterImages: [...previous, { ...input, boundAtRevision: record.revision + 1 }],
  });
  record.afterImages = parsed.afterImages;
}
