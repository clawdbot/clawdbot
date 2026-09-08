import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../../agent-compaction-constants.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import {
  extractObservedOverflowTokenCount,
  isCompactionFailureError,
  isLikelyContextOverflowError,
  isProviderRequestSizeCeilingError,
} from "../../embedded-agent-helpers.js";
import type { FailoverClassification } from "../../failover/signal.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { log } from "../logger.js";
import {
  getProviderPromptState,
  markLastProviderPromptContextRejected,
} from "../provider-prompt-state.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import {
  resolveLiveToolResultMaxChars,
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSessionManager,
} from "../tool-result-truncation.js";
import {
  compactEmbeddedRunForRecovery,
  type EmbeddedRunCompactionRecoveryInput,
} from "./compaction-runtime.js";
import { createRunRecoveryDiagId } from "./helpers.js";
import {
  isNoRealConversationCompactionNoop,
  resetNoRealConversationTokenSnapshot,
} from "./session-bootstrap.js";

function renderOverflowResetGuidance(
  attempt: EmbeddedRunCompactionRecoveryInput["attempt"],
): string {
  const replayMetadata = attempt.currentAttemptReplayMetadata ?? attempt.replayMetadata;
  const sideEffectCaution = replayMetadata.hadPotentialSideEffects
    ? " Completed tool actions were not replayed; verify their effects before retrying."
    : "";
  return (
    "Context overflow: prompt too large for the model. " +
    "Try /reset (or /new) to start a fresh session, or use a larger-context model." +
    sideEffectCaution
  );
}

type EmbeddedRunOverflowRecoveryOutcome =
  | { action: "none" }
  | { action: "retry" }
  | {
      action: "surface";
      kind: "compaction_failure" | "context_overflow";
      errorText: string;
      userText: string;
    };

export async function recoverEmbeddedRunOverflow(
  input: EmbeddedRunCompactionRecoveryInput & {
    aborted: boolean;
    signalOwnedInterruption: boolean;
    promptError: unknown;
    assistantErrorText?: string;
    assistantOverflowCandidate?: {
      message: AssistantMessage;
      classification: FailoverClassification | null;
    };
    toolResultPromptProjectionState: ToolResultPromptProjectionState;
    attemptCompactionCount: number;
    prepareCurrentTranscriptRetry: () => void;
    markOwnedTranscriptRetry: () => void;
  },
): Promise<EmbeddedRunOverflowRecoveryOutcome> {
  const assistant = input.assistantOverflowCandidate?.message;
  const classification = input.assistantOverflowCandidate?.classification;
  const contextOverflowError =
    !input.aborted && !input.signalOwnedInterruption
      ? (() => {
          if (input.promptError) {
            const errorText = formatErrorMessage(input.promptError);
            if (isLikelyContextOverflowError(errorText)) {
              return { text: errorText, source: "promptError" as const };
            }
            // A non-overflow prompt failure must not inherit a stale assistant
            // error from the previous transcript leaf.
            return null;
          }
          // Preserve the structured terminal outcome before the text-only fallback below.
          if (isProviderRefusalAssistantError(assistant)) {
            return null;
          }
          // This decision belongs to the selected response, not a text-only guess.
          if (assistant?.stopReason === "error" && classification?.kind === "reason") {
            return null;
          }
          if (
            assistant &&
            (classification?.kind === "context_overflow" ||
              (input.contextTokenBudget !== undefined &&
                isContextOverflow(assistant, input.contextTokenBudget)))
          ) {
            return {
              text: assistant.errorMessage?.trim() || "Context window exceeded",
              source: "assistantError" as const,
            };
          }
          if (assistant?.stopReason === "length") {
            return null;
          }
          if (input.assistantErrorText && isLikelyContextOverflowError(input.assistantErrorText)) {
            return { text: input.assistantErrorText, source: "assistantError" as const };
          }
          return null;
        })()
      : null;
  if (
    !contextOverflowError ||
    !input.genericCompactionRecoveryAllowed ||
    input.contextTokenBudget === undefined
  ) {
    return { action: "none" };
  }

  input.assertRecoveryActive();
  const contextTokenBudget = input.contextTokenBudget;
  const terminal = projectAgentRunAttemptTerminal(input.attempt.terminal);
  const providerPromptRejection =
    contextOverflowError.source === "assistantError" || terminal.promptErrorSource === "prompt"
      ? markLastProviderPromptContextRejected(getProviderPromptState(input.runParams.runId))
      : undefined;

  const runParams = input.runParams;
  const overflowDiagId = createRunRecoveryDiagId();
  const errorText = contextOverflowError.text;
  const observedOverflowTokens = extractObservedOverflowTokenCount(errorText);
  const preflightRecovery = input.attempt.preflightRecovery;
  const truncateToolResults = () => {
    const { sessionManager, assertActive } = input.prepareRecoverySession();
    if (!sessionManager) {
      return {
        truncated: false,
        truncatedCount: 0,
        reason: "detached recovery has no caller-owned transcript",
      };
    }
    const target = sessionManager.getSessionTarget();
    assertActive();
    const result = truncateOversizedToolResultsInSessionManager({
      sessionManager,
      contextWindowTokens: contextTokenBudget,
      maxCharsOverride: resolveLiveToolResultMaxChars({ contextWindowTokens: contextTokenBudget }),
      protectTrailingToolResults: preflightRecovery?.route === "compact_then_truncate",
      projectionState: input.toolResultPromptProjectionState,
      ...target,
    });
    assertActive();
    return result;
  };
  const preflightPromptBudget =
    terminal.promptErrorSource === "precheck" &&
    preflightRecovery?.source === "mid-turn" &&
    typeof preflightRecovery.promptBudgetBeforeReserve === "number" &&
    Number.isFinite(preflightRecovery.promptBudgetBeforeReserve) &&
    preflightRecovery.promptBudgetBeforeReserve > 0
      ? Math.floor(preflightRecovery.promptBudgetBeforeReserve)
      : undefined;
  const preflightEstimatedPromptTokens =
    typeof preflightRecovery?.estimatedPromptTokens === "number" &&
    Number.isFinite(preflightRecovery.estimatedPromptTokens) &&
    preflightRecovery.estimatedPromptTokens > 0
      ? Math.ceil(preflightRecovery.estimatedPromptTokens)
      : undefined;
  const overflowTokenCountForCompaction =
    observedOverflowTokens ??
    preflightEstimatedPromptTokens ??
    (input.contextTokenBudget > 0 ? input.contextTokenBudget + 1 : undefined);
  const activeSession = input.getActiveSession();
  log.warn(
    `[context-overflow-diag] sessionKey=${runParams.sessionKey ?? runParams.sessionId} ` +
      `provider=${input.provider}/${input.modelId} source=${contextOverflowError.source} ` +
      `messages=${input.attempt.messagesSnapshot?.length ?? 0} sessionFile=${activeSession.file} ` +
      `diagId=${overflowDiagId} compactionAttempts=${input.state.overflowCompactionAttempts} ` +
      `observedTokens=${observedOverflowTokens ?? "unknown"} ` +
      `preflightEstimatedTokens=${preflightEstimatedPromptTokens ?? "unknown"} ` +
      `compactionTokens=${overflowTokenCountForCompaction ?? "unknown"} ` +
      `providerPayloadBytes=${providerPromptRejection?.byteWeight ?? "unknown"} ` +
      `error=${truncateUtf16Safe(errorText, 200)}`,
  );

  const isCompactionFailure = isCompactionFailureError(errorText);

  // Compaction here budgets against the model's context window, so it cannot make the request fit
  // under the provider's own ceiling, and every retry re-sends a payload already rejected. Stop
  // the run instead of compacting, adopting a successor transcript, or truncating and retrying:
  // declining would return this to the same-model rate-limit retry that reported the refusal.
  if (isProviderRequestSizeCeilingError(errorText)) {
    log.warn(
      `[context-overflow-recovery] provider request-size ceiling for ${input.provider}/${input.modelId}; ` +
        `livenessState=blocked suggestedAction=reset_or_new kind=${isCompactionFailure ? "compaction_failure" : "context_overflow"} ` +
        `compaction=skipped retry=skipped`,
    );
    return {
      action: "surface",
      kind: isCompactionFailure ? "compaction_failure" : "context_overflow",
      errorText,
      userText: renderOverflowResetGuidance(input.attempt),
    };
  }

  // A parked code-mode run is bound to the session it started in and `wait`
  // rejects any other session, so a compaction that adopts a successor cannot
  // redeem parked nested work. The compaction itself stays committed (hooks and
  // maintenance still run); only the mid-turn continuation is withheld.
  let parkedWorkBlocksContinuation = false;
  if (
    !isCompactionFailure &&
    input.attemptCompactionCount > 0 &&
    input.state.overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
  ) {
    input.markOwnedTranscriptRetry();
    input.state.overflowCompactionAttempts += 1;
    log.warn(
      `context overflow persisted after in-attempt compaction (attempt ${input.state.overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); retrying prompt without additional compaction for ${input.provider}/${input.modelId}`,
    );
    if (preflightRecovery?.source === "mid-turn") {
      input.prepareCurrentTranscriptRetry();
    }
    return { action: "retry" };
  }

  if (
    !isCompactionFailure &&
    input.attemptCompactionCount === 0 &&
    input.state.overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
  ) {
    if (log.isEnabled("debug")) {
      log.debug(
        `[compaction-diag] decision diagId=${overflowDiagId} branch=compact ` +
          `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
          `attempt=${input.state.overflowCompactionAttempts + 1} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
      );
    }
    input.state.overflowCompactionAttempts += 1;
    log.warn(
      `context overflow detected (attempt ${input.state.overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); attempting auto-compaction for ${input.provider}/${input.modelId}`,
    );
    const compaction = await compactEmbeddedRunForRecovery(input, {
      tokenBudget: preflightPromptBudget ?? input.contextTokenBudget,
      trigger: "overflow",
      diagId: overflowDiagId,
      attempt: input.state.overflowCompactionAttempts,
      maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
      currentTokenCount: overflowTokenCountForCompaction,
    });
    const { result: compactResult, previousSessionId } = compaction;
    input.assertRecoveryActive();
    if (compactResult.ok && compactResult.compacted) {
      const adoptedSession = input.getActiveSession();
      // A parked Code Mode run cannot follow a rotated session. The compaction
      // stays committed, but only a same-session mid-turn continuation is safe.
      parkedWorkBlocksContinuation =
        previousSessionId !== undefined &&
        preflightRecovery?.source === "mid-turn" &&
        input.attempt.toolMetas.some((entry) => entry.codeModeSuspended === true);
      if (parkedWorkBlocksContinuation) {
        log.warn(
          `[context-overflow-recovery] compaction rotated ${previousSessionId} -> ${adoptedSession.id} ` +
            `while nested tool work was parked; not continuing mid-turn for ${input.provider}/${input.modelId}`,
        );
      }
      if (input.contextEngine.maintain) {
        const transcript = input.prepareRecoverySession();
        await runContextEngineMaintenance({
          ...transcript,
          contextEngine: input.contextEngine,
          sessionId: adoptedSession.id,
          sessionKey: runParams.sessionKey,
          sessionTarget: adoptedSession.target,
          sessionFile: adoptedSession.file,
          reason: "compaction",
          runtimeContext: compaction.runtimeContext,
          runtimeSettings: compaction.runtimeSettings,
          config: runParams.config,
          agentId: input.sessionAgentId,
          contextEngineAgentId: input.contextEngineAgentId,
          abortSignal: runParams.abortSignal,
        });
        input.assertRecoveryActive();
      }
    }
    await input.runOwnsCompactionAfterHook("overflow recovery", compactResult, previousSessionId);
    input.assertRecoveryActive();

    if (preflightRecovery && isNoRealConversationCompactionNoop(compactResult)) {
      input.state.lastCompactionTokensAfter = undefined;
      input.state.lastContextBudgetStatus = undefined;
      const transcript = input.prepareRecoverySession();
      await resetNoRealConversationTokenSnapshot({
        sessionTarget: transcript.sessionManager?.getSessionTarget(),
        sessionPersistence: runParams.sessionPersistence,
        assertActive: transcript.assertActive,
      });
      input.assertRecoveryActive();
      log.info(
        `[context-overflow-precheck] stale token state had no real conversation messages for ` +
          `${input.provider}/${input.modelId}; resetting the context snapshot and retrying prompt`,
      );
      if (preflightRecovery.source === "mid-turn") {
        input.prepareCurrentTranscriptRetry();
      }
      return { action: "retry" };
    }

    if (compactResult.compacted) {
      if (preflightRecovery?.route === "compact_then_truncate") {
        const truncResult = truncateToolResults();
        if (truncResult.truncated) {
          log.info(
            `[context-overflow-precheck] post-compaction tool-result truncation succeeded for ${input.provider}/${input.modelId}; truncated ${truncResult.truncatedCount} tool result(s)`,
          );
        } else {
          log.warn(
            `[context-overflow-precheck] post-compaction tool-result truncation did not help for ${input.provider}/${input.modelId}: ${truncResult.reason ?? "unknown"}`,
          );
        }
      }
      input.assertRecoveryActive();
      input.runParams.onAutoCompactionSucceeded?.(input.state.autoCompactionCount);
      input.assertRecoveryActive();
      input.armPostCompactionGuard();
      if (parkedWorkBlocksContinuation) {
        log.warn(
          `auto-compaction succeeded for ${input.provider}/${input.modelId}, but parked nested tool work cannot follow the rotated session; surfacing overflow guidance`,
        );
      } else {
        log.info(
          `auto-compaction succeeded for ${input.provider}/${input.modelId}; retrying prompt`,
        );
        input.markOwnedTranscriptRetry();
        if (preflightRecovery?.source === "mid-turn") {
          input.prepareCurrentTranscriptRetry();
        } else {
          await input.prepareCompactedTranscriptRetry(input.assertRecoveryActive);
          input.assertRecoveryActive();
        }
        return { action: "retry" };
      }
    } else {
      log.warn(
        `auto-compaction failed for ${input.provider}/${input.modelId}: ${compactResult.reason ?? "nothing to compact"}`,
      );
    }
  }

  if (!parkedWorkBlocksContinuation && !input.state.toolResultTruncationAttempted) {
    const toolResultMaxChars = resolveLiveToolResultMaxChars({
      contextWindowTokens: input.contextTokenBudget,
    });
    const hasOversized = input.attempt.messagesSnapshot
      ? sessionLikelyHasOversizedToolResults({
          messages: input.attempt.messagesSnapshot,
          contextWindowTokens: input.contextTokenBudget,
          maxCharsOverride: toolResultMaxChars,
        })
      : false;
    if (hasOversized) {
      input.state.toolResultTruncationAttempted = true;
      log.warn(
        `[context-overflow-recovery] Attempting tool result truncation for ${input.provider}/${input.modelId} ` +
          `(contextWindow=${input.contextTokenBudget} tokens)`,
      );
      const truncResult = truncateToolResults();
      if (truncResult.truncated) {
        input.markOwnedTranscriptRetry();
        log.info(
          `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
        );
        if (preflightRecovery?.source === "mid-turn") {
          input.prepareCurrentTranscriptRetry();
        }
        return { action: "retry" };
      }
      log.warn(
        `[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`,
      );
    }
  }

  if (
    (isCompactionFailure ||
      input.state.overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS) &&
    log.isEnabled("debug")
  ) {
    log.debug(
      `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
        `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
        `attempt=${input.state.overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
    );
  }
  const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
  const userText = renderOverflowResetGuidance(input.attempt);
  log.warn(
    `[context-overflow-recovery] exhausted provider overflow recovery for ${input.provider}/${input.modelId}; ` +
      `livenessState=blocked suggestedAction=reset_or_new kind=${kind}`,
  );
  return { action: "surface", kind, errorText, userText };
}
