import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { ContextEngine, ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { resolveProcessToolScopeKey } from "../../agent-tools.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import {
  extractObservedOverflowTokenCount,
  isCompactionFailureError,
  isLikelyContextOverflowError,
} from "../../embedded-agent-helpers.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "../compaction-safety-timeout.js";
import { resolveContextEngineCapabilities } from "../context-engine-capabilities.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { log } from "../logger.js";
import {
  getProviderPromptState,
  markLastProviderPromptContextRejected,
} from "../provider-prompt-state.js";
import {
  resolveLiveToolResultMaxChars,
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInActiveTarget,
} from "../tool-result-truncation.js";
import type { EmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createCompactionDiagId } from "./helpers.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import {
  buildContextEngineCompactionSessionTarget,
  isNoRealConversationCompactionNoop,
  resetNoRealConversationTokenSnapshot,
} from "./session-bootstrap.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;

type CompactResult = Awaited<ReturnType<ContextEngine["compact"]>>;

type ActiveSession = {
  id: string;
  file: string;
  target?: ContextEngineSessionTarget;
};

type EmbeddedRunOverflowRecoveryOutcome =
  | { action: "none" }
  | { action: "retry" }
  | {
      action: "surface";
      kind: "compaction_failure" | "context_overflow";
      errorText: string;
      userText: string;
    };

export async function recoverEmbeddedRunOverflow(input: {
  runParams: RunEmbeddedAgentParams;
  state: EmbeddedRunContextRecoveryState;
  contextEngine: ContextEngine;
  contextTokenBudget?: number;
  genericCompactionRecoveryAllowed: boolean;
  aborted: boolean;
  signalOwnedInterruption: boolean;
  promptError: unknown;
  assistantErrorText?: string;
  assistantOverflowCandidate?: AssistantMessage;
  attempt: EmbeddedRunAttemptResult;
  attemptCompactionCount: number;
  runtimeAuthPlan: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["runtimeAuthPlan"];
  resolvedSessionKey: string;
  sessionAgentId: string;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  modelId: string;
  harnessRuntime: string;
  thinkLevel: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  authProfileId?: string;
  authProfileIdSource: "auto" | "user";
  resolveContextEnginePluginId: () => string | undefined;
  buildRuntimeSettings: (settings: {
    tokenBudget?: number | null;
    degradedReason?: string | null;
  }) => ReturnType<typeof buildContextEngineRuntimeSettings>;
  onCompactionHookMessages: (payload: {
    phase: "before" | "after";
    messages: string[];
  }) => Promise<void>;
  runOwnsCompactionBeforeHook: (reason: string) => Promise<void>;
  runOwnsCompactionAfterHook: (
    reason: string,
    result: CompactResult,
    previousSessionId?: string,
  ) => Promise<void>;
  adoptCompactionTranscript: (result: CompactResult) => Promise<string | undefined>;
  getActiveSession: () => ActiveSession;
  prepareCurrentTranscriptRetry: () => void;
  prepareCompactedTranscriptRetry: () => Promise<void>;
  armPostCompactionGuard: () => void;
}): Promise<EmbeddedRunOverflowRecoveryOutcome> {
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
  const overflowDiagId = createCompactionDiagId();
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
      const sessionBeforeCompaction = input.getActiveSession();
      const overflowCompactionRuntimeContext = {
        ...buildEmbeddedCompactionRuntimeContext({
          sessionKey: runParams.sessionKey,
          messageChannel: runParams.messageChannel,
          messageProvider: runParams.messageProvider,
          clientCaps: runParams.clientCaps,
          chatType: runParams.chatType,
          agentAccountId: runParams.agentAccountId,
          currentChannelId: runParams.currentChannelId,
          currentThreadTs: runParams.currentThreadTs,
          currentMessageId: runParams.currentMessageId,
          authProfileId: input.authProfileId,
          authProfileIdSource: input.authProfileIdSource,
          runtimeAuthPlan: input.runtimeAuthPlan,
          workspaceDir: input.workspaceDir,
          agentDir: input.agentDir,
          config: runParams.config,
          skillsSnapshot: runParams.skillsSnapshot,
          senderId: runParams.senderId,
          provider: input.provider,
          modelId: input.modelId,
          harnessRuntime: input.harnessRuntime,
          modelSelectionLocked: runParams.modelSelectionLocked,
          modelFallbacksOverride: runParams.modelFallbacksOverride,
          thinkLevel: input.thinkLevel,
          reasoningLevel: runParams.reasoningLevel,
          bashElevated: runParams.bashElevated,
          extraSystemPrompt: runParams.extraSystemPrompt,
          sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
          ownerNumbers: runParams.ownerNumbers,
          activeProcessSessions: listActiveProcessSessionReferences({
            scopeKey: resolveProcessToolScopeKey({
              sessionKey: runParams.sandboxSessionKey?.trim() || runParams.sessionKey,
              sessionId: sessionBeforeCompaction.id,
              agentId: input.sessionAgentId,
            }),
          }),
        }),
        ...resolveContextEngineCapabilities({
          config: runParams.config,
          sessionKey: runParams.sessionKey,
          agentId: input.sessionAgentId,
          contextEnginePluginId: input.resolveContextEnginePluginId(),
          purpose: "context-engine.overflow-compaction",
        }),
        onCompactionHookMessages: input.onCompactionHookMessages,
        ...(input.attempt.promptCache ? { promptCache: input.attempt.promptCache } : {}),
        runId: runParams.runId,
        trigger: "overflow",
        ...(overflowTokenCountForCompaction !== undefined
          ? { currentTokenCount: overflowTokenCountForCompaction }
          : {}),
        diagId: overflowDiagId,
        attempt: input.state.overflowCompactionAttempts,
        maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
      };
      const overflowCompactionRuntimeSettings = input.buildRuntimeSettings({
        tokenBudget: input.contextTokenBudget,
        degradedReason: "context_overflow",
      });
      compactResult = await compactContextEngineWithSafetyTimeout(
        input.contextEngine,
        {
          sessionId: sessionBeforeCompaction.id,
          sessionKey: input.resolvedSessionKey,
          agentId: input.sessionAgentId,
          sessionTarget: buildContextEngineCompactionSessionTarget({
            agentId: input.sessionAgentId,
            config: runParams.config,
            sessionFile: sessionBeforeCompaction.file,
            sessionId: sessionBeforeCompaction.id,
            sessionKey: input.resolvedSessionKey,
            sessionTarget: sessionBeforeCompaction.target,
          }),
          tokenBudget: input.contextTokenBudget,
          ...(overflowTokenCountForCompaction !== undefined
            ? { currentTokenCount: overflowTokenCountForCompaction }
            : {}),
          force: true,
          compactionTarget: "budget",
          runtimeContext: overflowCompactionRuntimeContext,
          runtimeSettings: overflowCompactionRuntimeSettings,
        },
        resolveCompactionTimeoutMs(runParams.config),
        runParams.abortSignal,
      );
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
          runtimeContext: overflowCompactionRuntimeContext,
          runtimeSettings: overflowCompactionRuntimeSettings,
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
          config: runParams.config,
          protectTrailingToolResults: true,
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
      const truncResult = await truncateOversizedToolResultsInActiveTarget({
        scope: {
          sessionId: session.id,
          sessionKey: runParams.sessionKey ?? session.id,
          sessionFile: session.file,
          agentId: input.sessionAgentId,
        },
        contextWindowTokens: input.contextTokenBudget,
        maxCharsOverride: toolResultMaxChars,
        config: runParams.config,
        protectTrailingToolResults: preflightRecovery?.route === "compact_then_truncate",
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
