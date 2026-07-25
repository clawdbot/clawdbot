import { formatErrorMessage } from "../infra/errors.js";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import type { MainSessionRecoveryPendingTarget } from "./main-session-recovery-store.js";

const log = createSubsystemLogger("main-session-recovery");
const RESTORE_RETRY_DELAY_MS = 1_000;
const RESTORE_RETRY_MAX_DELAY_MS = 30_000;

export type RestoreAdmittedRecovery = () => Promise<MainSessionRecoveryPendingTarget | undefined>;

export async function restoreAdmittedRecoveryWithRetries(
  restore: RestoreAdmittedRecovery,
): Promise<MainSessionRecoveryPendingTarget | undefined> {
  return await retryAsync(restore, 3, 25);
}

export function scheduleAdmittedRecoveryRestore(
  restore: RestoreAdmittedRecovery,
  delayMs = RESTORE_RETRY_DELAY_MS,
): void {
  // Gateway admission consumed the reservation already. Keep restoration
  // alive until this exact idempotent callback repairs or rejects its fence.
  setTimeout(() => {
    void restoreAdmittedRecoveryWithRetries(restore).then(
      (pendingRecovery) => {
        scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
      },
      (error: unknown) => {
        log.warn(`failed delayed admitted recovery restoration: ${formatErrorMessage(error)}`);
        scheduleAdmittedRecoveryRestore(restore, Math.min(delayMs * 2, RESTORE_RETRY_MAX_DELAY_MS));
      },
    );
  }, delayMs).unref?.();
}
