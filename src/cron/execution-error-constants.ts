/** Stable cron execution error text shared by runtime and ledger codecs. */
export const CRON_JOB_EXECUTION_TIMEOUT_ERROR = "cron: job execution timed out";
export const CRON_SETUP_TIMEOUT_ERROR = "cron: isolated agent setup timed out before runner start";
export const CRON_PRE_EXECUTION_TIMEOUT_ERROR =
  "cron: isolated agent run stalled before execution start";

const CRON_TIMEOUT_ERROR_PREFIXES = [
  CRON_JOB_EXECUTION_TIMEOUT_ERROR,
  CRON_SETUP_TIMEOUT_ERROR,
  CRON_PRE_EXECUTION_TIMEOUT_ERROR,
] as const;

/** Recognizes watchdog timeouts without loading agent or execution-phase runtime. */
export function isCronTimeoutErrorText(error: unknown): error is string {
  return (
    typeof error === "string" &&
    CRON_TIMEOUT_ERROR_PREFIXES.some((prefix) => error === prefix || error.startsWith(`${prefix} `))
  );
}
