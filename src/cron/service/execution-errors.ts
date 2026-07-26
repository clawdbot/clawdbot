/** Formats stable cron timeout and execution error messages. */
import { formatEmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
import { CRON_JOB_EXECUTION_TIMEOUT_ERROR } from "../execution-error-constants.js";
import type { CronAgentExecutionStarted } from "../types.js";

function formatCronAgentExecutionPhase(execution?: CronAgentExecutionStarted): string | undefined {
  return formatEmbeddedAgentExecutionPhase(execution?.phase);
}

const CRON_SETUP_TIMEOUT_ERROR = "cron: isolated agent setup timed out before runner start";
const CRON_PRE_EXECUTION_TIMEOUT_ERROR = "cron: isolated agent run stalled before execution start";
const CRON_TIMEOUT_ERROR_PREFIXES: readonly string[] = [
  CRON_JOB_EXECUTION_TIMEOUT_ERROR,
  CRON_SETUP_TIMEOUT_ERROR,
  CRON_PRE_EXECUTION_TIMEOUT_ERROR,
];

function hasCronTimeoutPrefix(error: string, prefix: string): boolean {
  return error === prefix || error.startsWith(prefix + " ");
}

export function isCronTerminalAbortReasonText(error: string): boolean {
  for (const prefix of CRON_TIMEOUT_ERROR_PREFIXES) {
    if (hasCronTimeoutPrefix(error, prefix)) {
      return true;
    }
  }
  return false;
}

/** Formats the generic cron execution timeout message with last-known phase context when available. */
export function timeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return CRON_JOB_EXECUTION_TIMEOUT_ERROR;
  }
  return `${CRON_JOB_EXECUTION_TIMEOUT_ERROR} (last phase: ${phase})`;
}

/** Formats timeout text for runs that stalled before the isolated runner started. */
export function setupTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return CRON_SETUP_TIMEOUT_ERROR;
  }
  return `${CRON_SETUP_TIMEOUT_ERROR} (last phase: ${phase})`;
}

/** Returns true for the setup-timeout class that fires before the isolated runner starts. */
export function isSetupTimeoutErrorText(error: string): boolean {
  return hasCronTimeoutPrefix(error, CRON_SETUP_TIMEOUT_ERROR);
}

/** Formats timeout text for runs that stalled after setup but before execution start. */
export function preExecutionTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return CRON_PRE_EXECUTION_TIMEOUT_ERROR;
  }
  return `${CRON_PRE_EXECUTION_TIMEOUT_ERROR} (last phase: ${phase})`;
}

/** Extracts a human timeout/abort reason, falling back to the canonical cron timeout text. */
export function resolveCronAbortReasonText(reason: unknown): string | undefined {
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message.trim();
  }
  return undefined;
}

/** Extracts a human timeout/abort reason, falling back to the canonical cron timeout text. */
export function abortErrorMessage(signal?: AbortSignal): string {
  return resolveCronAbortReasonText(signal?.reason) ?? timeoutErrorMessage();
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === "AbortError" || err.message === timeoutErrorMessage();
}

/** Normalizes thrown cron run failures into stable log/run-history text. */
export function normalizeCronRunErrorText(err: unknown): string {
  if (isAbortError(err)) {
    return timeoutErrorMessage();
  }
  if (typeof err === "string") {
    return err === `Error: ${timeoutErrorMessage()}` ? timeoutErrorMessage() : err;
  }
  return String(err);
}
