import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { streamSimple } from "../../llm/stream.js";
import type { AssistantMessage, Model } from "../../llm/types.js";
import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type CompactionResult,
} from "../runtime/index.js";
import { AgentSessionInspection } from "./agent-session-inspection.js";
import { unwrapCoreResult } from "./agent-session-utils.js";
import { formatNoModelSelectedMessage } from "./auth-guidance.js";
import { getLatestCompactionEntry, type CompactionEntry } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

type CompactionReason = "manual" | "threshold" | "overflow";
type CompactionWorkOutcome =
  | { status: "compacted"; result: CompactionResult }
  | { status: "aborted" }
  | { status: "skipped" };

export abstract class AgentSessionCompaction extends AgentSessionInspection {
  // =========================================================================
  // Compaction
  // =========================================================================

  /**
   * Manually compact the session context.
   * Aborts current agent operation first.
   * @param customInstructions Optional instructions for the compaction summary
   */
  async compact(customInstructions?: string): Promise<CompactionResult> {
    return await this.runWithSessionWriteLock(
      async () => await this.compactWithSessionWriteLock(customInstructions),
    );
  }

  private async compactWithSessionWriteLock(
    customInstructions?: string,
  ): Promise<CompactionResult> {
    this.disconnectFromAgent();
    await this.abort();
    this.compactionAbortController = new AbortController();
    this.emit({ type: "compaction_start", reason: "manual" });

    try {
      const settings = this.settingsManager.getCompactionSettings();
      const outcome = await this.runCompactionWork({
        customInstructions,
        mode: "manual",
        settings,
        signal: this.compactionAbortController.signal,
      });
      if (outcome.status !== "compacted") {
        throw new Error("Compaction cancelled");
      }

      this.emit({
        type: "compaction_end",
        reason: "manual",
        result: outcome.result,
        aborted: false,
        willRetry: false,
      });
      return outcome.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted =
        message === "Compaction cancelled" ||
        (error instanceof Error && error.name === "AbortError");
      this.emit({
        type: "compaction_end",
        reason: "manual",
        result: undefined,
        aborted,
        willRetry: false,
        errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
      });
      throw error;
    } finally {
      this.compactionAbortController = undefined;
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

  private async getAutoCompactionRequestAuth(model: Model): Promise<
    | {
        apiKey?: string;
        headers?: Record<string, string>;
      }
    | undefined
  > {
    if (this.agent.streamFn !== streamSimple) {
      return this.getCompactionRequestAuth(model);
    }

    const authResult = await this.sessionModelRegistry.getApiKeyAndHeaders(model);
    if (!authResult.ok || !authResult.apiKey) {
      return undefined;
    }
    const { apiKey, headers } = authResult;
    return { apiKey, headers };
  }

  private async runCompactionWork(options: {
    settings: ReturnType<SettingsManager["getCompactionSettings"]>;
    signal: AbortSignal;
    customInstructions?: string;
    mode: "manual" | "auto";
  }): Promise<CompactionWorkOutcome> {
    const isManual = options.mode === "manual";
    if (!this.model) {
      if (isManual) {
        throw new Error(formatNoModelSelectedMessage());
      }
      return { status: "skipped" };
    }

    const auth = isManual
      ? await this.getCompactionRequestAuth(this.model)
      : await this.getAutoCompactionRequestAuth(this.model);
    if (!auth) {
      return { status: "skipped" };
    }

    const pathEntries = this.sessionManager.getBranch();
    const preparation = unwrapCoreResult(prepareCompaction(pathEntries, options.settings));
    if (!preparation) {
      if (isManual) {
        const lastEntry = pathEntries[pathEntries.length - 1];
        throw new Error(
          lastEntry?.type === "compaction"
            ? "Already compacted"
            : "Nothing to compact (session too small)",
        );
      }
      return { status: "skipped" };
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
      });

      if (extensionResult?.cancel) {
        return { status: "aborted" };
      }

      if (extensionResult?.compaction) {
        compactionResult = extensionResult.compaction;
        fromExtension = true;
      }
    }

    compactionResult ??= unwrapCoreResult(
      await compact(
        preparation,
        this.model,
        auth.apiKey,
        auth.headers,
        options.customInstructions,
        options.signal,
        this.thinkingLevel,
        this.agent.streamFn,
      ),
    );

    if (options.signal.aborted) {
      return { status: "aborted" };
    }

    this.sessionManager.appendCompaction(
      compactionResult.summary,
      compactionResult.firstKeptEntryId,
      compactionResult.tokensBefore,
      compactionResult.details,
      fromExtension,
    );
    const newEntries = this.sessionManager.getEntries();
    const sessionContext = this.sessionManager.buildSessionContext();
    this.agent.state.messages = sessionContext.messages;

    const savedCompactionEntry = newEntries.find(
      (e) => e.type === "compaction" && e.summary === compactionResult.summary,
    ) as CompactionEntry | undefined;

    if (this.currentExtensionRunner && savedCompactionEntry) {
      await this.currentExtensionRunner.emit({
        type: "session_compact",
        compactionEntry: savedCompactionEntry,
        fromExtension,
      });
    }

    return { status: "compacted", result: compactionResult };
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

    // Case 1: Overflow - LLM returned context overflow error
    if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
      if (this.overflowRecoveryAttempted) {
        this.emit({
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage:
            "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
        });
        return false;
      }

      this.overflowRecoveryAttempted = true;
      // Remove the error message from agent state (it IS saved to session for history,
      // but we don't want it in context for the retry)
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
      // Verify the usage source is post-compaction. Kept pre-compaction messages
      // have stale usage reflecting the old (larger) context and would falsely
      // trigger compaction right after one just finished.
      const usageMsg = messages.at(estimate.lastUsageIndex);
      if (
        compactionEntry &&
        usageMsg?.role === "assistant" &&
        usageMsg.timestamp <= new Date(compactionEntry.timestamp).getTime()
      ) {
        return false;
      }
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
    this.autoCompactionAbortController = new AbortController();

    try {
      const outcome = await this.runCompactionWork({
        mode: "auto",
        settings,
        signal: this.autoCompactionAbortController.signal,
      });
      if (outcome.status === "skipped") {
        this.emit({
          type: "compaction_end",
          reason,
          result: undefined,
          aborted: false,
          willRetry: false,
        });
        return false;
      }
      if (outcome.status === "aborted") {
        this.emit({
          type: "compaction_end",
          reason,
          result: undefined,
          aborted: true,
          willRetry: false,
        });
        return false;
      }
      this.emit({
        type: "compaction_end",
        reason,
        result: outcome.result,
        aborted: false,
        willRetry,
      });

      if (willRetry) {
        const messages = this.agent.state.messages;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg.stopReason === "error") {
          this.agent.state.messages = messages.slice(0, -1);
        }
        return true;
      }

      // Auto-compaction can complete while follow-up/steering/custom messages are waiting.
      // Continue once so queued messages are delivered.
      return this.agent.hasQueuedMessages();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "compaction failed";
      this.emit({
        type: "compaction_end",
        reason,
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage:
          reason === "overflow"
            ? `Context overflow recovery failed: ${errorMessage}`
            : `Auto-compaction failed: ${errorMessage}`,
      });
      return false;
    } finally {
      this.autoCompactionAbortController = undefined;
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
