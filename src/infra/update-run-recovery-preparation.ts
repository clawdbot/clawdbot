import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { PackageRecoveryVerified } from "./package-update-recovery.js";
import { finishAbortedUpdatePreparationInTransaction } from "./update-run-ledger.js";
import { isRecoverablePreparationNative } from "./update-run-recovery-native-schema.js";
import { parseRecoveryPackageObservation } from "./update-run-recovery-package-schema.js";
import {
  UpdateRecoveryConflictError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import { mutateRecovery } from "./update-run-recovery-store.js";
import type { UpdateRecoveryFence } from "./update-run-recovery-types.js";

/** Necessary historical shape only. Fresh source/native/package observations
 * and live exclusion are still required before settlement. */
export function assertUnstartedUpdatePreparation(record: UpdateRecoveryRecord): void {
  const p = record.package;
  if (
    !record.source ||
    !record.preimages ||
    !record.nativeManager ||
    !p ||
    record.effects.length !== 0 ||
    !isRecoverablePreparationNative(record.nativeManager) ||
    record.handoff ||
    record.checkpoint ||
    record.afterImages !== undefined ||
    record.restore ||
    record.publication ||
    record.verification ||
    record.terminal ||
    record.retainedPair ||
    record.primaryFailure ||
    record.preparationAborted ||
    p.descriptor.retention !== null ||
    p.descriptor.interruptedLaunchers.length !== 0 ||
    p.descriptor.liveRoot !== record.from.root ||
    p.observed.observation.previous !== "live" ||
    p.observed.observation.candidate !== "staged" ||
    !["previous", "both"].includes(p.observed.observation.launchers) ||
    p.observed.observation.successorLive
  ) {
    throw new UpdateRecoveryConflictError();
  }
}

/** The caller keeps the installation, config/include and native owners live.
 * Native restoration must already be independently observed. This commit changes
 * no artifacts or native state. History and marker commit together. */
export function abortUpdatePreparation(
  expected: UpdateRecoveryRecord,
  observation: PackageRecoveryVerified,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions,
): UpdateRecoveryRecord {
  const observed = parseRecoveryPackageObservation(observation);
  return mutateRecovery(
    expected,
    fence,
    (record, db) => {
      assertUnstartedUpdatePreparation(record);
      if (
        record.claimKind !== "recovery" ||
        !isRecoverablePreparationNative(record.nativeManager!, true) ||
        !isDeepStrictEqual(record, expected) ||
        !isDeepStrictEqual(observed, record.package!.observed)
      ) {
        throw new UpdateRecoveryConflictError();
      }
      finishAbortedUpdatePreparationInTransaction(
        db,
        record.runId,
        options,
        record.nativeManager!.effects.length !== 0,
      );
      record.primaryFailure = { code: "interrupted-preparation", effectId: null };
      record.preparationAborted = {
        reason: "interrupted-preparation",
        committedAtMs: Math.max(Date.now(), record.updatedAtMs + 1),
        commitRevision: record.revision + 1,
        observedIdentity: observed.observedIdentity,
      };
    },
    options,
  );
}
