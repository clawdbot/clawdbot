import { deriveContextPromptTokens, normalizeUsage } from "../../usage.js";
import { runPostCompactionSideEffects } from "../compaction-hooks.js";
import { log } from "../logger.js";
import {
  compactEmbeddedRunForRecovery,
  type EmbeddedRunCompactionRecoveryInput,
} from "./compaction-runtime.js";
import { createRunRecoveryDiagId } from "./helpers.js";

const MAX_TIMEOUT_COMPACTION_ATTEMPTS = 2;

export async function recoverEmbeddedRunTimeout(
  input: EmbeddedRunCompactionRecoveryInput & {
    timedOut: boolean;
    signalOwnedInterruption: boolean;
    timedOutDuringCompaction: boolean;
    timedOutDuringToolExecution: boolean;
    timedOutByRunBudget: boolean;
    lastRunPromptUsage?: ReturnType<typeof normalizeUsage>;
  },
): Promise<boolean> {
  if (
    !input.genericCompactionRecoveryAllowed ||
    input.contextTokenBudget === undefined ||
    !input.timedOut ||
    input.signalOwnedInterruption ||
    input.timedOutDuringCompaction ||
    input.timedOutDuringToolExecution ||
    input.timedOutByRunBudget
  ) {
    return false;
  }

  // API totals include output tokens. Timeout compaction only considers the
  // prompt-side pressure that can actually be reduced by compaction.
  const lastTurnPromptTokens = deriveContextPromptTokens({
    lastCallUsage: input.lastRunPromptUsage,
  });
  const tokenUsedRatio =
    lastTurnPromptTokens != null && input.contextTokenBudget > 0
      ? lastTurnPromptTokens / input.contextTokenBudget
      : 0;
  if (input.state.timeoutCompactionAttempts >= MAX_TIMEOUT_COMPACTION_ATTEMPTS) {
    log.warn(
      `[timeout-compaction] already attempted timeout compaction ${input.state.timeoutCompactionAttempts} time(s); falling through to failover rotation`,
    );
    return false;
  }
  if (tokenUsedRatio <= 0.65) {
    return false;
  }

  input.assertRecoveryActive();
  const timeoutDiagId = createRunRecoveryDiagId();
  input.state.timeoutCompactionAttempts += 1;
  log.warn(
    `[timeout-compaction] LLM timed out with high prompt token usage (${Math.round(tokenUsedRatio * 100)}%); ` +
      `attempting compaction before retry (attempt ${input.state.timeoutCompactionAttempts}/${MAX_TIMEOUT_COMPACTION_ATTEMPTS}) diagId=${timeoutDiagId}`,
  );
  const { result: timeoutCompactResult, previousSessionId } = await compactEmbeddedRunForRecovery(
    input,
    {
      tokenBudget: input.contextTokenBudget,
      trigger: "timeout_recovery",
      diagId: timeoutDiagId,
      attempt: input.state.timeoutCompactionAttempts,
      maxAttempts: MAX_TIMEOUT_COMPACTION_ATTEMPTS,
    },
  );
  input.assertRecoveryActive();
  await input.runOwnsCompactionAfterHook(
    "timeout recovery",
    timeoutCompactResult,
    previousSessionId,
  );
  input.assertRecoveryActive();
  if (!timeoutCompactResult.compacted) {
    log.warn(
      `[timeout-compaction] compaction did not reduce context for ${input.provider}/${input.modelId}; falling through to normal handling`,
    );
    return false;
  }

  input.runParams.onAutoCompactionSucceeded?.(input.state.autoCompactionCount);
  input.assertRecoveryActive();
  // Detached recovery still compacts and retries its local context, but cannot
  // publish a durable session update or start session-memory index writes.
  if (
    timeoutCompactResult.ok &&
    input.contextEngine.info.ownsCompaction === true &&
    input.runParams.sessionPersistence !== "detached"
  ) {
    const activeSession = input.getActiveSession();
    await runPostCompactionSideEffects({
      config: input.runParams.config,
      sessionKey: input.runParams.sessionKey,
      sessionId: activeSession.id,
      agentId: input.sessionAgentId,
      sessionFile: activeSession.file,
      assertActive: input.assertRecoveryActive,
    });
    input.assertRecoveryActive();
  }
  log.info(
    `[timeout-compaction] compaction succeeded for ${input.provider}/${input.modelId}; retrying prompt`,
  );
  input.armPostCompactionGuard();
  await input.prepareCompactedTranscriptRetry(input.assertRecoveryActive);
  input.assertRecoveryActive();
  return true;
}
