import type { FailoverReason } from "../agents/failover/signal.js";
import type { CronFailureNotificationDetail, CronTriggerFailureCode } from "./types.js";

const GENERIC_FAILURE_DETAIL = "Check automation history for details.";

const SCRIPT_FAILURE_COPY = {
  aborted: "was aborted",
  invalid_input: "received invalid input",
  runtime_unavailable: "runtime is unavailable",
  timeout: "timed out",
  output_limit_exceeded: "exceeded its output limit",
  snapshot_limit_exceeded: "exceeded its state limit",
  internal_error: "failed internally",
  tool_budget_exceeded: "exceeded its tool budget",
} satisfies Record<CronTriggerFailureCode, string>;

/** Renders only classified reasons or closed producer-authored failure facts. */
export function cronFailureDetailLines(
  errorReason: FailoverReason | undefined,
  failureNotificationDetail?: CronFailureNotificationDetail,
): string[] {
  if (errorReason) {
    return errorReason === "model_not_found"
      ? [
          `Cause: ${errorReason}`,
          "Run `openclaw doctor --fix` to repair provider-declared retired model references.",
          "Choose a supported model for this automation or remove its model override to use the agent default. If the agent default is unavailable, update it too.",
        ]
      : [`Cause: ${errorReason}`];
  }
  if (!failureNotificationDetail) {
    return [GENERIC_FAILURE_DETAIL];
  }
  if (failureNotificationDetail.kind === "command-exit") {
    return [`Cause: command exited with code ${failureNotificationDetail.exitCode}`];
  }
  if (failureNotificationDetail.kind === "command-timeout") {
    return [
      failureNotificationDetail.mode === "wall-clock"
        ? "Cause: command timed out"
        : "Cause: command stopped after producing no output",
    ];
  }
  const label =
    failureNotificationDetail.source === "payload" ? "automation script" : "trigger script";
  return [`Cause: ${label} ${SCRIPT_FAILURE_COPY[failureNotificationDetail.code]}`];
}
