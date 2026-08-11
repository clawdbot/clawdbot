import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ContextEngine } from "../../../context-engine/types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import {
  extractObservedOverflowTokenCount,
  isCompactionFailureError,
  isLikelyContextOverflowError,
} from "../../embedded-agent-helpers.js";
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
  truncateOversizedToolResultsInActiveTarget,
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

const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;

type CompactResult = Awaited<ReturnType<ContextEngine["compact"]>>;

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
    assistantOverflowCandidate?: AssistantMessage;
    toolResultPromptProjectionState: ToolResultPromptProjectionState;
    attemptCompactionCount: number;
    prepareCurrentTranscriptRetry: () => void;
    prepareCompactedTranscriptRetry: () => Promise<void>;
  },
): Promise<EmbeddedRunOverflowRecoveryOutcome> {
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
          if (
            input.assistantOverflowCandidate &&
            input.contextTokenBudget !== undefined &&
            isContextOverflow(input.assistantOverflowCandidate, input.contextTokenBudget)
          ) {
            return {
              text:
                input.assistantOverflowCandidate.errorMessage?.trim() || "Context window exceeded",
              source: "assistantError" as const,
            };
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

  const providerPromptRejection =
    contextOverflowError.source === "assistantError" ||
    projectAgentRunAttemptTerminal(input.attempt.terminal).promptErrorSource === "prompt"
      ? markLastProviderPromptContextRejected(getProviderPromptState(input.runParams.runId))
      : undefined;

  const runParams = input.runParams;
  const overflowDiagId = createRunRecoveryDiagId();
  const errorText = contextOverflowError.text;
  const observedOverflowTokens = extractObservedOverflowTokenCount(errorText);
  const preflightRecovery = input.attempt.preflightRecovery;
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
  if (
    !isCompactionFailure &&
    input.attemptCompactionCount > 0 &&
    input.state.overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
  ) {
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
    let compactResult: CompactResult;
    let previousSessionId: string | undefined;
    await input.runOwnsCompactionBeforeHook("overflow recovery");
    try {
      const compaction = await compactEmbeddedRunForRecovery(input, {
        tokenBudget: input.contextTokenBudget,
        trigger: "overflow",
        diagId: overflowDiagId,
        attempt: input.state.overflowCompactionAttempts,
        maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
        currentTokenCount: overflowTokenCountForCompaction,
      });
      compactResult = compaction.result;
      if (compactResult.ok && compactResult.compacted) {
        previousSessionId = await input.adoptCompactionTranscript(compactResult);
        const sessionAfterCompaction = input.getActiveSession();
        await runContextEngineMaintenance({
          contextEngine: input.contextEngine,
          sessionId: sessionAfterCompaction.id,
          sessionKey: runParams.sessionKey,
          sessionTarget: sessionAfterCompaction.target,
          sessionFile: sessionAfterCompaction.file,
          reason: "compaction",
          runtimeContext: compaction.runtimeContext,
          runtimeSettings: compaction.runtimeSettings,
          config: runParams.config,
          agentId: input.sessionAgentId,
        });
      }
    } catch (compactErr) {
      log.warn(
        `contextEngine.compact() threw during overflow recovery for ${input.provider}/${input.modelId}: ${String(compactErr)}`,
      );
      compactResult = { ok: false, compacted: false, reason: String(compactErr) };
    }
    await input.runOwnsCompactionAfterHook("overflow recovery", compactResult, previousSessionId);

    if (preflightRecovery && isNoRealConversationCompactionNoop(compactResult)) {
      input.state.lastCompactionTokensAfter = undefined;
      input.state.lastContextBudgetStatus = undefined;
      await resetNoRealConversationTokenSnapshot({
        config: runParams.config,
        sessionKey: runParams.sessionKey,
        agentId: input.sessionAgentId,
      });
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
      await input.adoptCompactionTranscript(compactResult);
      const tokensAfter = compactResult.result?.tokensAfter;
      if (typeof tokensAfter === "number" && Number.isFinite(tokensAfter) && tokensAfter >= 0) {
        input.state.lastCompactionTokensAfter = Math.floor(tokensAfter);
      }
      if (preflightRecovery?.route === "compact_then_truncate") {
        const sessionAfterCompaction = input.getActiveSession();
        // Recovery must preserve stored rows and branch from the frozen provider projection.
        // Rewriting in place erases audit history and can persist bytes the provider never saw.
        const truncResult = await truncateOversizedToolResultsInActiveTarget({
          scope: {
            sessionId: sessionAfterCompaction.id,
            sessionKey: runParams.sessionKey ?? sessionAfterCompaction.id,
            sessionFile: sessionAfterCompaction.file,
            agentId: input.sessionAgentId,
          },
          contextWindowTokens: input.contextTokenBudget,
          maxCharsOverride: resolveLiveToolResultMaxChars({
            contextWindowTokens: input.contextTokenBudget,
          }),
          protectTrailingToolResults: true,
          projectionState: input.toolResultPromptProjectionState,
        });
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
      input.state.autoCompactionCount += 1;
      log.info(`auto-compaction succeeded for ${input.provider}/${input.modelId}; retrying prompt`);
      input.armPostCompactionGuard();
      if (preflightRecovery?.source === "mid-turn") {
        input.prepareCurrentTranscriptRetry();
      } else {
        await input.prepareCompactedTranscriptRetry();
      }
      return { action: "retry" };
    }
    log.warn(
      `auto-compaction failed for ${input.provider}/${input.modelId}: ${compactResult.reason ?? "nothing to compact"}`,
    );
  }

  if (!input.state.toolResultTruncationAttempted) {
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
      const session = input.getActiveSession();
      // Recovery must preserve stored rows and branch from the frozen provider projection.
      // Rewriting in place erases audit history and can persist bytes the provider never saw.
      const truncResult = await truncateOversizedToolResultsInActiveTarget({
        scope: {
          sessionId: session.id,
          sessionKey: runParams.sessionKey ?? session.id,
          sessionFile: session.file,
          agentId: input.sessionAgentId,
        },
        contextWindowTokens: input.contextTokenBudget,
        maxCharsOverride: toolResultMaxChars,
        protectTrailingToolResults: preflightRecovery?.route === "compact_then_truncate",
        projectionState: input.toolResultPromptProjectionState,
      });
      if (truncResult.truncated) {
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
  const userText =
    "Context overflow: prompt too large for the model. " +
    "Try /reset (or /new) to start a fresh session, or use a larger-context model.";
  log.warn(
    `[context-overflow-recovery] exhausted provider overflow recovery for ${input.provider}/${input.modelId}; ` +
      `livenessState=blocked suggestedAction=reset_or_new kind=${kind}`,
  );
  return { action: "surface", kind, errorText, userText };
}
