/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import {
  runAgentHarnessAttempt,
  runAgentHarnessSettledTurnFinalization,
} from "../../harness/selection.js";
import type { AgentHarness } from "../../harness/types.js";
import type { AgentRuntimeModelAttempt, AgentRuntimePlan } from "../../runtime-plan/types.js";
import {
  markRequesterTurnYielded,
  settleRequesterAfterSessionSpawns,
} from "../../subagents/registry/subagent-registry.js";
import { copyCoreTtsAttemptResultProvenance } from "../../tools/tts-tool-result-provenance.js";
import { shouldContinueInteractiveAcceptedSessionSpawns } from "./attempt-terminal-evidence.js";
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
  nativeSessionRuntime?: Parameters<typeof runAgentHarnessAttempt>[1],
): Promise<EmbeddedRunAttemptResult> {
  const result = await runAgentHarnessAttempt(params, nativeSessionRuntime);
  if (
    result.agentHarnessId !== "openclaw" &&
    params.sessionKey &&
    result.acceptedSessionSpawns?.length
  ) {
    const implicitContinuation = shouldContinueInteractiveAcceptedSessionSpawns({
      attempt: result,
      run: params,
    });
    if (implicitContinuation) {
      const marked = markRequesterTurnYielded({
        requesterSessionKey: params.sessionKey,
        requesterAgentId: params.agentId,
        requesterTurnRunId: params.runId,
      });
      if (marked === 0) {
        throw new Error("accepted continuation children were not durably registered");
      }
    } else {
      settleRequesterAfterSessionSpawns({
        requesterSessionKey: params.sessionKey,
        requesterAgentId: params.agentId,
        requesterTurnRunId: params.runId,
        requesterYielded: result.yieldDetected === true,
        acceptedSessionSpawns: result.acceptedSessionSpawns,
      });
    }
  }
  const { modelAttempt: _backendModelAttempt, runtimeModelSelection, ...attempt } = result;
  const modelAttempt = resolveRuntimeModelAttempt(params.runtimePlan);
  return copyCoreTtsAttemptResultProvenance(result, {
    ...attempt,
    ...(modelAttempt ? { modelAttempt } : {}),
    // Only private prepared ownership permits a runtime to select the session model.
    ...(nativeSessionRuntime && runtimeModelSelection
      ? {
          runtimeModelSelection: {
            provider: runtimeModelSelection.provider,
            model: runtimeModelSelection.model,
          },
        }
      : {}),
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
