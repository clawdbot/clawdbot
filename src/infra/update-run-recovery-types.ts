import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
/** Current executor-held exclusion, never deserialized. CAS does not authorize effects. */
export type UpdateRecoveryFence = { assertCurrent: () => void };
export type UpdateRecoveryRevision = Pick<
  UpdateRecoveryRecord,
  "runId" | "transactionId" | "revision" | "claimId"
>;

/** Correlation only. The receiving runtime must independently reacquire authority. */
export type UpdateRecoveryHandoff = UpdateRecoveryRevision & { handoffId: string };

/** Immutable plan binding; the exact active record is validated separately. */
export type UpdateRecoveryDatabaseBinding = {
  runId: string;
  transactionId: string;
  sha256: string;
};
