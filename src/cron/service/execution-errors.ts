/** Formats stable cron timeout and execution error messages. */
import { formatEmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
import type { CronAgentExecutionStarted } from "../types.js";

function formatCronAgentExecutionPhase(execution?: CronAgentExecutionStarted): string | undefined {
  return formatEmbeddedAgentExecutionPhase(execution?.phase);
}

/** Formats the generic cron execution timeout message with last-known phase context when available. */
export function timeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return "cron: job execution timed out";
  }
  return `cron: job execution timed out (last phase: ${phase})`;
}

/** Formats timeout text for runs that stalled before the isolated runner started. */
export function setupTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return "cron: isolated agent setup timed out before runner start";
  }
  return `cron: isolated agent setup timed out before runner start (last phase: ${phase})`;
}

/** Formats timeout text for runs that stalled after setup but before execution start. */
export function preExecutionTimeoutErrorMessage(execution?: CronAgentExecutionStarted): string {
  const phase = formatCronAgentExecutionPhase(execution);
  if (!phase) {
    return "cron: isolated agent run stalled before execution start";
  }
  return `cron: isolated agent run stalled before execution start (last phase: ${phase})`;
}

/** Extracts a human timeout/abort reason, falling back to the canonical cron timeout text. */
export function abortErrorMessage(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  return timeoutErrorMessage();
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === "AbortError" || err.message === timeoutErrorMessage();
}

/** Normalizes thrown cron run failures into stable log/run-log text. */
export function normalizeCronRunErrorText(err: unknown): string {
  if (isAbortError(err)) {
    return timeoutErrorMessage();
  }
  if (typeof err === "string") {
    return err === `Error: ${timeoutErrorMessage()}` ? timeoutErrorMessage() : err;
  }
  return String(err);
}
