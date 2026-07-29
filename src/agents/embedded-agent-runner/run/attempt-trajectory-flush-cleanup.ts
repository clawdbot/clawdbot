/**
 * Flushes attempt trajectory recorders during cleanup.
 */
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";

/** Minimal recorder surface needed to flush trajectory data during run cleanup. */
type EmbeddedAttemptTrajectoryRecorder = {
  describeFlushState: () => string | undefined;
  flush: () => Promise<void>;
};

/**
 * Flushes attempt trajectory data through the shared cleanup timeout wrapper so
 * stuck recorder writes warn with run/session context instead of blocking run
 * teardown indefinitely.
 */
export async function flushEmbeddedAttemptTrajectoryRecorder(params: {
  runId: string;
  sessionId: string;
  trajectoryRecorder: EmbeddedAttemptTrajectoryRecorder | null;
  log: {
    warn: (message: string) => void;
  };
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "openclaw-trajectory-flush",
    log: params.log,
    env: params.env,
    timeoutMs: params.timeoutMs,
    getTimeoutDetails: () => params.trajectoryRecorder?.describeFlushState(),
    cleanup: async () => {
      await params.trajectoryRecorder?.flush();
    },
  });
}
