/** Formats stable cron timeout and execution error messages. */
import { formatEmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
import { extractErrorCode, formatErrorMessageWithCode } from "../../infra/errors.js";
import {
  CRON_JOB_EXECUTION_TIMEOUT_ERROR,
  CRON_PRE_EXECUTION_TIMEOUT_ERROR,
  CRON_SETUP_TIMEOUT_ERROR,
  isCronTimeoutErrorText,
} from "../execution-error-constants.js";
import type { CronAgentExecutionStarted } from "../types.js";

function formatCronAgentExecutionPhase(execution?: CronAgentExecutionStarted): string | undefined {
  return formatEmbeddedAgentExecutionPhase(execution?.phase);
}

function hasCronTimeoutPrefix(error: string, prefix: string): boolean {
  return error === prefix || error.startsWith(prefix + " ");
}

export function isCronTerminalAbortReasonText(error: string): boolean {
  return isCronTimeoutErrorText(error);
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
  if (reason instanceof Error) {
    const message = reason.message.trim();
    // Only an empty abort or one already carrying cron's canonical timeout text
    // is unspecified. Coded aborts and other messages retain their exact reason.
    if (extractErrorCode(reason) === undefined && (!message || message === timeoutErrorMessage())) {
      return undefined;
    }
    return formatErrorMessageWithCode(reason);
  }
  return undefined;
}

/** Extracts a human timeout/abort reason, falling back to the canonical cron timeout text. */
export function abortErrorMessage(signal?: AbortSignal): string {
  return resolveCronAbortReasonText(signal?.reason) ?? timeoutErrorMessage();
}

/** Normalizes thrown cron run failures into stable log/run-history text. */
export function normalizeCronRunErrorText(err: unknown): string {
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.trim() === timeoutErrorMessage())
  ) {
    return resolveCronAbortReasonText(err) ?? timeoutErrorMessage();
  }
  return formatErrorMessageWithCode(err);
}
