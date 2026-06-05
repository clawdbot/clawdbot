/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import { runAgentHarnessAttempt } from "../../harness/selection.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/**
 * Backend bridge for executing one embedded-agent attempt through the selected harness.
 */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  return runAgentHarnessAttempt(params);
}
