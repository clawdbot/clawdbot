/**
 * Built-in OpenClaw harness registration.
 *
 * Harness selection uses this factory to expose the embedded OpenClaw runtime
 * through the same AgentHarness contract as external harness plugins.
 */
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { runEmbeddedAttempt } from "../embedded-agent-runner/run/attempt.js";
import { projectSettledTurnFinalizationAttemptResult } from "./settled-turn-finalization-result.js";
import type { AgentHarness, AgentHarnessAttemptParams } from "./types.js";

function buildRestrictedFinalizationAttempt(
  attempt: AgentHarnessAttemptParams,
): AgentHarnessAttemptParams {
  return {
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionTarget,
    lifecycleGeneration: attempt.lifecycleGeneration,
    promptCacheKey: attempt.promptCacheKey,
    sandboxSessionKey: attempt.sandboxSessionKey,
    agentId: attempt.agentId,
    workspaceDir: attempt.workspaceDir,
    cwd: attempt.cwd,
    agentDir: attempt.agentDir,
    config: attempt.config,
    prompt: attempt.prompt,
    timeoutMs: attempt.timeoutMs,
    runTimeoutOverrideMs: attempt.runTimeoutOverrideMs,
    runId: attempt.runId,
    abortSignal: attempt.abortSignal,
    onExecutionStarted: attempt.onExecutionStarted,
    onExecutionPhase: attempt.onExecutionPhase,
    onLaneWait: attempt.onLaneWait,
    onRunProgress: attempt.onRunProgress,
    onAttemptTimeoutArmed: attempt.onAttemptTimeoutArmed,
    onAttemptTimeout: attempt.onAttemptTimeout,
    onAttemptAbort: attempt.onAttemptAbort,
    preparedModelRuntime: attempt.preparedModelRuntime,
    sessionFile: attempt.sessionFile,
    contextTokenBudget: attempt.contextTokenBudget,
    contextWindowInfo: attempt.contextWindowInfo,
    resolvedApiKey: attempt.resolvedApiKey,
    authProfileId: attempt.authProfileId,
    authProfileIdSource: attempt.authProfileIdSource,
    provider: attempt.provider,
    modelId: attempt.modelId,
    requestedModelId: attempt.requestedModelId,
    agentHarnessId: attempt.agentHarnessId,
    runtimePlan: attempt.runtimePlan,
    model: attempt.model,
    authStorage: attempt.authStorage,
    authProfileStore: attempt.authProfileStore,
    toolAuthProfileStore: attempt.toolAuthProfileStore,
    modelRegistry: attempt.modelRegistry,
    thinkLevel: attempt.thinkLevel,
    fastMode: attempt.fastMode,
    fastModeAuto: attempt.fastModeAuto,
    operation: "settled-tool-finalization",
    disableTools: true,
    disableTrajectory: true,
    skipPreparedUserTurnMessage: true,
    initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
  };
}

/** Creates the built-in harness backed by the embedded OpenClaw agent runner. */
export function createOpenClawAgentHarness(): AgentHarness {
  return {
    id: "openclaw",
    label: "OpenClaw embedded agent",
    contextEngineHostCapabilities: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: runEmbeddedAttempt,
    finalizeSettledTurn: async ({ attempt }) => {
      // Preserve only transcript/model transport state. The operation-specific
      // runner path suppresses every ambient prompt and capability contributor.
      const result = await runEmbeddedAttempt(buildRestrictedFinalizationAttempt(attempt));
      return projectSettledTurnFinalizationAttemptResult(result);
    },
  };
}
