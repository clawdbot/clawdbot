/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import {
  runAgentHarnessAttempt,
  runAgentHarnessSettledTurnFinalization,
} from "../../harness/selection.js";
import type {
  AgentHarness,
  AgentHarnessSettledTurnFinalizationResult,
} from "../../harness/types.js";
import { settleRequesterAfterSessionSpawns } from "../../subagent-registry.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/**
 * Backend bridge for executing one embedded-agent attempt through the selected harness.
 */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const result = await runAgentHarnessAttempt(params);
  if (
    result.agentHarnessId !== "openclaw" &&
    params.sessionKey &&
    result.acceptedSessionSpawns?.length
  ) {
    // Native harnesses return only after releasing active-run ownership.
    // Settle before dispatch can replace the successful result with a late abort.
    settleRequesterAfterSessionSpawns({
      requesterSessionKey: params.sessionKey,
      requesterTurnRunId: params.runId,
      requesterYielded: result.yieldDetected === true,
      acceptedSessionSpawns: result.acceptedSessionSpawns,
    });
  }
  return result;
}

/** Runs one operation-specific settled-turn finalization through the selected harness. */
export async function runEmbeddedSettledTurnFinalizationWithBackend(
  params: EmbeddedRunAttemptParams,
  settledAttempt: EmbeddedRunAttemptResult,
  harness: AgentHarness,
): Promise<AgentHarnessSettledTurnFinalizationResult> {
  return runAgentHarnessSettledTurnFinalization(params, settledAttempt, harness);
}
