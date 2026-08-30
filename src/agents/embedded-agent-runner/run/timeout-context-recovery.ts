import { requireSessionKeyOrSkip } from "../../../infra/session-keys.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../../infra/system-events.js";
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

  const timeoutDiagId = createRunRecoveryDiagId();
  input.state.timeoutCompactionAttempts += 1;
  log.warn(
    `[timeout-compaction] LLM timed out with high prompt token usage (${Math.round(tokenUsedRatio * 100)}%); ` +
      `attempting compaction before retry (attempt ${input.state.timeoutCompactionAttempts}/${MAX_TIMEOUT_COMPACTION_ATTEMPTS}) diagId=${timeoutDiagId}`,
  );
  log.warn(
    `[context-pressure:fire] mid-turn trigger=timeout ratio=${Math.round(tokenUsedRatio * 100)}% ` +
      `tokens=${Math.round((lastTurnPromptTokens ?? 0) / 1000)}k/${Math.round(input.contextTokenBudget / 1000)}k ` +
      `sessionKey=${input.runParams.sessionKey ?? input.runParams.sessionId}`,
  );
  const timeoutSessionKey = requireSessionKeyOrSkip(
    input.runParams,
    log,
    "pi-runner.timeout-compaction",
  );
  if (timeoutSessionKey) {
    enqueueSystemEvent(
      `[system:context-pressure] Mid-turn compaction triggered at ${Math.round(tokenUsedRatio * 100)}% ` +
        `context (${Math.round((lastTurnPromptTokens ?? 0) / 1000)}k/${Math.round(input.contextTokenBudget / 1000)}k tokens). ` +
        "Your last reply hit the provider timeout ceiling. Consider evacuating working state " +
        "earlier via continue_delegate(post-compaction) or memory files so the next turn starts " +
        "with room to grow.",
      { sessionKey: timeoutSessionKey },
    );
  }
  let timeoutCompactResult: Awaited<ReturnType<typeof input.contextEngine.compact>>;
  await input.runOwnsCompactionBeforeHook("timeout recovery");
  try {
    ({ result: timeoutCompactResult } = await compactEmbeddedRunForRecovery(input, {
      tokenBudget: input.contextTokenBudget,
      trigger: "timeout_recovery",
      diagId: timeoutDiagId,
      attempt: input.state.timeoutCompactionAttempts,
      maxAttempts: MAX_TIMEOUT_COMPACTION_ATTEMPTS,
    }));
  } catch (compactErr) {
    log.warn(
      `[timeout-compaction] contextEngine.compact() threw during timeout recovery for ${input.provider}/${input.modelId}: ${String(compactErr)}`,
    );
    timeoutCompactResult = {
      ok: false,
      compacted: false,
      reason: String(compactErr),
    };
  }

  const previousSessionId = timeoutCompactResult.compacted
    ? await input.adoptCompactionTranscript(timeoutCompactResult)
    : undefined;
  await input.runOwnsCompactionAfterHook(
    "timeout recovery",
    timeoutCompactResult,
    previousSessionId,
  );
  if (!timeoutCompactResult.compacted) {
    log.warn(
      `[timeout-compaction] compaction did not reduce context for ${input.provider}/${input.modelId}; falling through to normal handling`,
    );
    return false;
  }

  const compactionCount = ++input.state.autoCompactionCount;
  input.runParams.onAutoCompactionSucceeded?.(compactionCount);
  const tokensAfter = timeoutCompactResult.result?.tokensAfter;
  if (typeof tokensAfter === "number" && Number.isFinite(tokensAfter) && tokensAfter >= 0) {
    input.state.lastCompactionTokensAfter = Math.floor(tokensAfter);
  }
  if (input.contextEngine.info.ownsCompaction === true) {
    const activeSession = input.getActiveSession();
    await runPostCompactionSideEffects({
      config: input.runParams.config,
      sessionKey: input.runParams.sessionKey,
      sessionId: activeSession.id,
      agentId: input.sessionAgentId,
      sessionFile: activeSession.file,
    });
  }
  log.info(
    `[timeout-compaction] compaction succeeded for ${input.provider}/${input.modelId}; retrying prompt`,
  );
  input.armPostCompactionGuard();
  await input.prepareCompactedTranscriptRetry();
  return true;
}
