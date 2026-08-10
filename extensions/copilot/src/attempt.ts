import { finalizeCopilotAttempt } from "./attempt-cleanup.js";
import {
  createPromptError,
  createResult,
  readString,
  resolvePoolAcquire,
  toError,
} from "./attempt-config.js";
import { runCopilotExecution } from "./attempt-execution.js";
import { prepareCopilotAttemptContext } from "./attempt-prepare.js";
import type {
  AgentHarnessAttemptResult,
  CopilotAttemptDeps,
  CopilotAttemptParams,
} from "./attempt-types.js";
import { resolveCopilotProvider } from "./provider-bridge.js";
export type { CopilotSessionConfig } from "./attempt-types.js";
export { resolvePoolAcquire };
export async function runCopilotAttempt(
  params: CopilotAttemptParams,
  deps: CopilotAttemptDeps,
): Promise<AgentHarnessAttemptResult> {
  const now = deps.now ?? Date.now;
  const attemptStartedAt = now();
  const {
    settledToolFinalization,
    input,
    createToolBridge,
    ringZeroSystemAgentRun,
    messages,
    modelRef,
    resolvedWorkspaceForSandbox,
    sandboxSessionKey,
    sessionAgentId,
    hookContextWindowFields,
    hookContext,
  } = prepareCopilotAttemptContext(params, deps);
  const finishAttempt = (result: AgentHarnessAttemptResult) =>
    settledToolFinalization
      ? Promise.resolve(result)
      : finalizeCopilotAttempt(input, result, hookContext, attemptStartedAt, now);
  if (params.abortSignal?.aborted) {
    return finishAttempt(
      createResult(input, {
        aborted: true,
        externalAbort: true,
        messagesSnapshot: messages,
        now,
        promptError: undefined,
        sdkSessionId: undefined,
        sessionIdUsed: input.sessionId,
      }),
    );
  }
  try {
    resolveCopilotProvider({
      model: modelRef,
      resolvedApiKey: readString(params.resolvedApiKey),
      authProfileId: readString(params.authProfileId),
    });
  } catch (error) {
    return finishAttempt(
      createResult(input, {
        messagesSnapshot: messages,
        now,
        promptError: createPromptError("model_not_supported", toError(error).message, error),
        sdkSessionId: undefined,
        sessionIdUsed: input.sessionId,
      }),
    );
  }
  const settledFinalizationSessionId = settledToolFinalization
    ? readString(input.initialReplayState?.sdkSessionId)
    : undefined;
  if (settledToolFinalization && !settledFinalizationSessionId) {
    return finishAttempt(
      createResult(input, {
        messagesSnapshot: messages,
        now,
        promptError: createPromptError(
          "settled_finalization_session_unavailable",
          "[copilot-attempt] settled tool finalization requires the existing Copilot SDK session",
        ),
        sdkSessionId: undefined,
        sessionIdUsed: input.sessionId,
      }),
    );
  }
  return await runCopilotExecution({
    params,
    deps,
    now,
    attemptStartedAt,
    settledToolFinalization,
    input,
    createToolBridge,
    ringZeroSystemAgentRun,
    messages,
    modelRef,
    resolvedWorkspaceForSandbox,
    sandboxSessionKey,
    sessionAgentId,
    hookContextWindowFields,
    hookContext,
    finishAttempt,
    settledFinalizationSessionId,
  });
}
