/**
 * Releases attempt resources when an embedded-agent run aborts.
 */
import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

type AbortLockReleaseLog = {
  warn(message: string): void;
};

/**
 * Releases the held session lock after an abort without blocking abort
 * propagation. Release failures are logged because the caller is already
 * unwinding the run and cannot safely await lock cleanup there.
 */
export function releaseEmbeddedAttemptSessionLockForAbort(params: {
  sessionLockController: Pick<EmbeddedAttemptSessionLockController, "releaseHeldLockForAbort">;
  log: AbortLockReleaseLog;
  runId: string;
  abortKind: "abort" | "timeout abort";
}): void {
  void params.sessionLockController.releaseHeldLockForAbort().catch((err: unknown) => {
    params.log.warn(
      `failed to release session lock on ${params.abortKind}: runId=${params.runId} ${String(err)}`,
    );
  });
}
