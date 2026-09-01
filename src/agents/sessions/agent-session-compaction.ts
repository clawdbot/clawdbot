import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { capCompactionSummary } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { InvalidSummaryOutputError } from "../../../packages/agent-core/src/harness/types.js";
import type { AssistantMessage } from "../../llm/types.js";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../agent-compaction-constants.js";
import { resolveCompactionInstructions } from "../agent-hooks/compaction-instructions.js";
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type CompactionPreparation,
  type CompactionResult,
} from "../runtime/index.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
import { AgentSessionInspection } from "./agent-session-inspection.js";
import { unwrapCoreResult } from "./agent-session-utils.js";
import { formatNoModelSelectedMessage } from "./auth-guidance.js";
import { createCompactionRuntime } from "./compaction/runtime.js";
import { preflightManualSessionCompaction } from "./manual-compaction-preflight.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import { recordSessionModelUsage } from "./session-model-usage.js";
import type { SettingsManager } from "./settings-manager.js";

type CompactionReason = "manual" | "threshold" | "overflow";
type CompactionRequestState = "unresolved";
type SummaryOutputPolicy = "none" | "retry-invalid-once";
type CompactionWorkOutcome =
  | { status: "completed"; result: CompactionResult; tokensAfter: number }
  | { status: "aborted" }
  | { status: "skipped"; reason: string };

function compactionErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() ? message : fallback;
}

/** @internal */
export const agentSessionAutomaticCompaction: unique symbol = Symbol.for(
  "openclaw.agent-session.automatic-compaction",
);

/** Installs a synchronous callback for model-context replacement during compaction. */
export const agentSessionSetContextReplacementHook: unique symbol = Symbol.for(
  "openclaw.agent-session.set-context-replacement-hook",
);

export abstract class AgentSessionCompaction extends AgentSessionInspection {
  private onContextReplaced?: (tokensAfter: number) => void;

  [agentSessionSetContextReplacementHook](
    callback: ((tokensAfter: number) => void) | undefined,
  ): void {
    this.onContextReplaced = callback;
  }

  // =========================================================================
  // Compaction
  // =========================================================================

  /**
   * Manually compact the session context.
   * Aborts current agent operation first.
   * @param customInstructions Optional instructions for the compaction summary
   */
  async compact(customInstructions?: string): Promise<CompactionResult> {
    return await this.compactWithPolicy(customInstructions, "none");
  }

  async [agentSessionAutomaticCompaction](
    customInstructions?: string,
    requestState?: CompactionRequestState,
    summaryOutputPolicy: SummaryOutputPolicy = "retry-invalid-once",
  ): Promise<CompactionResult> {
    return await this.compactWithPolicy(customInstructions, summaryOutputPolicy, requestState);
  }

  private async compactWithPolicy(
    customInstructions: string | undefined,
    summaryOutputPolicy: SummaryOutputPolicy,
    requestState?: CompactionRequestState,
  ): Promise<CompactionResult> {
    return await this.runWithSessionWriteSettlement(
      async () =>
        await this.compactWithSessionWriteSettlement(
          customInstructions,
          summaryOutputPolicy,
          requestState,
        ),
    );
  }

  private async compactWithSessionWriteSettlement(
    customInstructions?: string,
    summaryOutputPolicy: SummaryOutputPolicy = "none",
    requestState?: CompactionRequestState,
  ): Promise<CompactionResult> {
    this.disconnectFromAgent();
    await this.abort();
    const abortController = new AbortController();
    this.compactionAbortController = abortController;
    this.emit({ type: "compaction_start", reason: "manual" });

    try {
      const settings = this.settingsManager.getCompactionSettings();
      let outcome: CompactionWorkOutcome;
      try {
        outcome = await this.runCompactionWork({
          customInstructions,
          mode: "manual",
          summaryOutputPolicy,
          requestState,
          settings,
          signal: abortController.signal,
        });
      } catch (error) {
        const message = compactionErrorMessage(error, "Compaction failed");
        const aborted =
          abortController.signal.aborted || (error instanceof Error && error.name === "AbortError");
        this.emit({
          type: "compaction_end",
          reason: "manual",
          outcome: aborted
            ? { status: "aborted" }
            : { status: "failed", reason: `Compaction failed: ${message}` },
        });
        throw error;
      }
      if (outcome.status === "skipped") {
        this.emit({ type: "compaction_end", reason: "manual", outcome });
        throw new Error(outcome.reason);
      }
      if (outcome.status === "aborted") {
        this.emit({ type: "compaction_end", reason: "manual", outcome });
        throw new Error("Compaction cancelled");
      }

      this.emit({
        type: "compaction_end",
        reason: "manual",
        outcome: {
          status: "completed",
          tokensBefore: outcome.result.tokensBefore,
          tokensAfter: outcome.tokensAfter,
          willRetry: false,
        },
      });
      return outcome.result;
    } finally {
      if (this.compactionAbortController === abortController) {
        this.compactionAbortController = undefined;
      }
      this.reconnectToAgent();
    }
  }

  /**
   * Cancel in-progress compaction (manual or auto).
   */
  abortCompaction(): void {
    this.compactionAbortController?.abort();
    this.autoCompactionAbortController?.abort();
  }

  /**
   * Cancel in-progress branch summarization.
   */
  abortBranchSummary(): void {
    this.branchSummaryAbortController?.abort();
  }

  private async runCompactionWork(options: {
    settings: ReturnType<SettingsManager["getCompactionSettings"]>;
    signal: AbortSignal;
    customInstructions?: string;
    mode: "manual" | "auto";
    requestState?: CompactionRequestState;
    summaryOutputPolicy: SummaryOutputPolicy;
  }): Promise<CompactionWorkOutcome> {
    const isManual = options.mode === "manual";
    if (!this.model) {
      if (isManual) {
        throw new Error(formatNoModelSelectedMessage());
      }
      return { status: "skipped", reason: formatNoModelSelectedMessage() };
    }
    const model = this.model;

    let auth: Awaited<ReturnType<typeof this.getCompactionRequestAuth>>;
    try {
      auth = await this.getCompactionRequestAuth(model);
    } catch (error) {
      if (isManual) {
        throw error;
      }
      return {
        status: "skipped",
        reason: compactionErrorMessage(error, "Compaction authentication failed"),
      };
    }

    const pathEntries = this.sessionManager.getBranch();
    let preparation: CompactionPreparation | undefined;
    if (isManual && !options.requestState) {
      const manualPreflight = preflightManualSessionCompaction(pathEntries, options.settings);
      if (!manualPreflight.compactable) {
        throw new Error(manualPreflight.reason);
      }
      preparation = manualPreflight.preparation;
    } else {
      preparation = unwrapCoreResult(
        prepareCompaction(pathEntries, options.settings, options.requestState),
      );
    }
    if (!preparation) {
      return { status: "skipped", reason: "Nothing to compact (session too small)" };
    }

    let compactionResult: CompactionResult | undefined;
    let fromExtension = false;
    if (this.currentExtensionRunner.hasHandlers("session_before_compact")) {
      const extensionResult = await this.currentExtensionRunner.emit({
        type: "session_before_compact",
        preparation,
        branchEntries: pathEntries,
        customInstructions: options.customInstructions,
        signal: options.signal,
        // Extension-owned compaction must use the same prepared model execution
        // context as the core path below or provider wrappers and reasoning drift.
        thinkingLevel: this.thinkingLevel,
        streamFn: this.agent.streamFn,
      });

      if (extensionResult?.cancel) {
        return { status: "aborted" };
      }

      if (extensionResult?.compaction) {
        compactionResult = extensionResult.compaction;
        fromExtension = true;
      }
    }

    if (!compactionResult) {
      // Hooks keep the original input. Only the host's core path bounds raw focus
      // before escaping, and both summaries and any retry share this prepared text.
      const focus = normalizeOptionalString(options.customInstructions);
      const boundedFocus = focus ? resolveCompactionInstructions(focus, undefined) : undefined;
      const focusInstructions = boundedFocus
        ? wrapUntrustedPromptDataBlock({ label: "Compaction focus", text: boundedFocus })
        : "";
      const unresolvedRequestInstructions = preparation.latestUnresolvedUserRequest
        ? [
            "The run owner will resume this request after compaction. Preserve it as current work.",
            wrapUntrustedPromptDataBlock({
              label: "Latest unresolved user request",
              text: preparation.latestUnresolvedUserRequest,
            }),
          ].join("\n")
        : "";
      const coreInstructions = [focusInstructions, unresolvedRequestInstructions]
        .filter(Boolean)
        .join("\n\n");
      const runCoreCompaction = () =>
        compact(
          preparation,
          model,
          auth.apiKey,
          auth.headers,
          coreInstructions || undefined,
          options.signal,
          this.thinkingLevel,
          this.agent.streamFn,
          createCompactionRuntime((usage) => recordSessionModelUsage(this.sessionManager, usage)),
        );
      let result = await runCoreCompaction();
      // Automatic core compaction owns one retry for invalid summary output.
      // Manual, provider-error, and extension-owned paths keep their own policy.
      if (options.signal.aborted) {
        return { status: "aborted" };
      }
      if (
        options.summaryOutputPolicy === "retry-invalid-once" &&
        !result.ok &&
        result.error instanceof InvalidSummaryOutputError
      ) {
        result = await runCoreCompaction();
        if (options.signal.aborted) {
          return { status: "aborted" };
        }
      }
      compactionResult = unwrapCoreResult(result);
    }

    if (options.signal.aborted) {
      return { status: "aborted" };
    }

    compactionResult = {
      ...compactionResult,
      summary: capCompactionSummary(compactionResult.summary),
    };

    const compactionEntryId = this.sessionManager.appendCompaction(
      compactionResult.summary,
      compactionResult.firstKeptEntryId,
      compactionResult.tokensBefore,
      compactionResult.details,
      fromExtension,
    );
    const sessionContext = this.sessionManager.buildSessionContext();
    // Compaction replaces the request prefix, invalidating retained usage and thinking signatures.
    // Sanitize at assignment so every continuation driver receives replay-safe history.
    this.agent.state.messages = sanitizeCompactionReplayMessages(sessionContext.messages);
    // Commit accounting and invalidation must precede awaited extension work;
    // cancellation there can prevent the public completed event from reaching its owner.
    this.onContextReplaced?.(estimateContextTokens(this.agent.state.messages).tokens);

    const savedCompactionEntry = this.sessionManager.getEntry(compactionEntryId);
    if (this.currentExtensionRunner && savedCompactionEntry?.type === "compaction") {
      await this.currentExtensionRunner.emit({
        type: "session_compact",
        compactionEntry: savedCompactionEntry,
        fromExtension,
      });
    }

    const tokensAfter = estimateContextTokens(this.agent.state.messages).tokens;
    return { status: "completed", result: compactionResult, tokensAfter };
  }

  /**
   * Check if compaction is needed and run it.
   * Called after agent_end and before prompt submission.
   *
   * Two cases:
   * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
   * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
   *
   * @param assistantMessage The assistant message to check
   * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
   */
  protected async checkCompaction(
    assistantMessage: AssistantMessage,
    skipAbortedCheck = true,
  ): Promise<boolean> {
    const settings = this.settingsManager.getCompactionSettings();
    if (!settings.enabled) {
      return false;
    }

    // Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
    if (skipAbortedCheck && assistantMessage.stopReason === "aborted") {
      return false;
    }

    const contextWindow = this.model?.contextWindow ?? 0;

    // Skip overflow check if the message came from a different model.
    // This handles the case where user switched from a smaller-context model (e.g. opus)
    // to a larger-context model (e.g. codex) - the overflow error from the old model
    // shouldn't trigger compaction for the new model.
    const sameModel =
      this.model &&
      assistantMessage.provider === this.model.provider &&
      assistantMessage.model === this.model.id;

    // Skip compaction checks if this assistant message is older than the latest
    // compaction boundary. This prevents a stale pre-compaction usage/error
    // from retriggering compaction on the first prompt after compaction.
    const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
    const assistantIsFromBeforeCompaction =
      compactionEntry !== null &&
      assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
    if (assistantIsFromBeforeCompaction) {
      return false;
    }

    // Case 1: Overflow - an unsuccessful response needs compact-and-retry recovery.
    // Successful high-usage responses fall through to threshold maintenance below.
    if (
      sameModel &&
      (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "length") &&
      isContextOverflow(assistantMessage, contextWindow)
    ) {
      if (this.contextOverflowRecoveryOwner === "caller") {
        return false;
      }
      if (this.overflowRecoveryAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
        this.emit({
          type: "compaction_end",
          reason: "overflow",
          outcome: {
            status: "failed",
            reason: `Context overflow recovery failed after ${MAX_OVERFLOW_COMPACTION_ATTEMPTS} compact-and-retry attempts. Try reducing context or switching to a larger-context model.`,
          },
        });
        return false;
      }

      this.overflowRecoveryAttempts += 1;
      // Keep the failed response in history, but exclude it from the retry context.
      const messages = this.agent.state.messages;
      if (messages.at(-1)?.role === "assistant") {
        this.agent.state.messages = messages.slice(0, -1);
      }
      return await this.runAutoCompaction("overflow", true);
    }

    // Case 2: Threshold - context is getting large
    // For error messages (no usage data), estimate from last successful response.
    // This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
    let contextTokens: number;
    if (assistantMessage.stopReason === "error") {
      const messages = this.agent.state.messages;
      const estimate = estimateContextTokens(messages);
      if (estimate.lastUsageIndex === null) {
        return false;
      } // No usage data at all
      contextTokens = estimate.tokens;
    } else if (assistantMessage.usage.contextUsage?.state === "unavailable") {
      const estimatedContextTokens = this.getContextUsage()?.tokens;
      if (estimatedContextTokens == null) {
        return false;
      }
      contextTokens = estimatedContextTokens;
    } else {
      contextTokens = calculateContextTokens(assistantMessage.usage);
    }
    if (shouldCompact(contextTokens, contextWindow, settings)) {
      return await this.runAutoCompaction("threshold", false);
    }
    return false;
  }

  /**
   * Internal: Run auto-compaction with events.
   */
  private async runAutoCompaction(
    reason: Exclude<CompactionReason, "manual">,
    willRetry: boolean,
  ): Promise<boolean> {
    const settings = this.settingsManager.getCompactionSettings();

    this.emit({ type: "compaction_start", reason });
    const abortController = new AbortController();
    this.autoCompactionAbortController = abortController;

    try {
      const outcome = await this.runCompactionWork({
        mode: "auto",
        ...(willRetry ? { requestState: "unresolved" as const } : {}),
        summaryOutputPolicy: "retry-invalid-once",
        settings,
        signal: abortController.signal,
      });
      if (outcome.status === "skipped") {
        this.emit({ type: "compaction_end", reason, outcome });
        return false;
      }
      if (outcome.status === "aborted") {
        this.emit({ type: "compaction_end", reason, outcome });
        return false;
      }
      this.emit({
        type: "compaction_end",
        reason,
        outcome: {
          status: "completed",
          tokensBefore: outcome.result.tokensBefore,
          tokensAfter: outcome.tokensAfter,
          willRetry,
        },
      });

      if (willRetry) {
        const messages = this.agent.state.messages;
        const lastMsg = messages[messages.length - 1];
        if (
          lastMsg?.role === "assistant" &&
          (lastMsg.stopReason === "error" || lastMsg.stopReason === "length")
        ) {
          this.agent.state.messages = messages.slice(0, -1);
        }
        return true;
      }

      // Auto-compaction can complete while follow-up/steering/custom messages are waiting.
      // Continue once so queued messages are delivered.
      return this.agent.hasQueuedMessages();
    } catch (error) {
      if (abortController.signal.aborted) {
        this.emit({ type: "compaction_end", reason, outcome: { status: "aborted" } });
        return false;
      }
      const errorMessage = compactionErrorMessage(error, "compaction failed");
      this.emit({
        type: "compaction_end",
        reason,
        outcome: {
          status: "failed",
          reason:
            reason === "overflow"
              ? `Context overflow recovery failed: ${errorMessage}`
              : `Auto-compaction failed: ${errorMessage}`,
        },
      });
      return false;
    } finally {
      if (this.autoCompactionAbortController === abortController) {
        this.autoCompactionAbortController = undefined;
      }
    }
  }

  /**
   * Toggle auto-compaction setting.
   */
  setAutoCompactionEnabled(enabled: boolean): void {
    this.settingsManager.setCompactionEnabled(enabled);
  }

  /** Whether auto-compaction is enabled */
  get autoCompactionEnabled(): boolean {
    return this.settingsManager.getCompactionEnabled();
  }
}
