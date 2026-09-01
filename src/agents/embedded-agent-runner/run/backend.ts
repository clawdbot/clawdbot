/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import {
  runAgentHarnessAttempt,
  runAgentHarnessSettledTurnFinalization,
} from "../../harness/selection.js";
import type { AgentHarness } from "../../harness/types.js";
import type { AgentRuntimeModelAttempt, AgentRuntimePlan } from "../../runtime-plan/types.js";
import { settleRequesterAfterSessionSpawns } from "../../subagents/registry/subagent-registry.js";
import { copyCoreTtsAttemptResultProvenance } from "../../tools/tts-tool-result-provenance.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/** Replaces backend-retained provenance with the exact prepared request fact. */
export function resolveRuntimeModelAttempt(
  runtimePlan: AgentRuntimePlan | undefined,
): AgentRuntimeModelAttempt | undefined {
  const credentialSource = runtimePlan?.auth.credentialSource;
  return credentialSource
    ? {
        provider: runtimePlan.resolvedRef.provider,
        model: runtimePlan.resolvedRef.modelId,
        credentialSource,
      }
    : undefined;
}

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
      requesterAgentId: params.agentId,
      requesterTurnRunId: params.runId,
      requesterYielded: result.yieldDetected === true,
      acceptedSessionSpawns: result.acceptedSessionSpawns,
    });
  }
  const { modelAttempt: _backendModelAttempt, ...attempt } = result;
  const modelAttempt = resolveRuntimeModelAttempt(params.runtimePlan);
  return copyCoreTtsAttemptResultProvenance(result, {
    ...attempt,
    ...(modelAttempt ? { modelAttempt } : {}),
  });
}

/** Runs one operation-specific settled-turn finalization through the selected harness. */
export async function runEmbeddedSettledTurnFinalizationWithBackend(
  params: EmbeddedRunAttemptParams,
  settledAttempt: EmbeddedRunAttemptResult,
  harness: AgentHarness,
) {
  return runAgentHarnessSettledTurnFinalization(params, settledAttempt, harness);
}
