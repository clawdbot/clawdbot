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
  input: Omit<UpdateRecoveryAfterImage, "boundAtRevision"> & {
    /** The last runtime mutation is acknowledged in the same CAS as its sealed outputs. */
    mutation?: { effectId: string; observedIdentity: string; failureCode?: string };
  },
): void {
  const { mutation, ...image } = input;
  const last = record.effects.at(-1);
  if (
    mutation &&
    (!last ||
      last.effectId !== mutation.effectId ||
      last.kind !== "runtime-mutation" ||
      last.runtime !== "candidate" ||
      last.state !== "intent" ||
      image.effectIds.at(-1) !== last.effectId)
  ) {
    throw new UpdateRecoveryConflictError();
  }
  const previous = record.afterImages ?? [];
  const covered = previous.reduce((count, prior) => count + prior.effectIds.length, 0);
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
    ...(mutation
      ? {
          effects: [
            ...record.effects.slice(0, -1),
            { ...last, state: "observed", observedIdentity: mutation.observedIdentity },
          ],
          primaryFailure:
            record.primaryFailure ??
            (mutation.failureCode
              ? { code: mutation.failureCode, effectId: mutation.effectId }
              : null),
        }
      : {}),
    afterImages: [...previous, { ...image, boundAtRevision: record.revision + 1 }],
  });
  record.effects = parsed.effects;
  record.primaryFailure = parsed.primaryFailure;
  record.afterImages = parsed.afterImages;
}
