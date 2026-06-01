import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

type AbortLockReleaseLog = {
  warn(message: string): void;
};

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
