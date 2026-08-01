import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import type { AssistantMessage } from "../../llm/types.js";
import { classifyRateLimitWindow } from "../../llm/utils/rate-limit-window.js";
import { isRetryableAssistantError } from "../../llm/utils/retry.js";
import { sleep } from "../utils/sleep.js";
import { AgentSessionExtensions } from "./agent-session-extensions.js";
import { type BashResult, executeBashWithOperations } from "./bash-executor.js";
import type { BashExecutionMessage } from "./messages.js";
import type { BashOperations } from "./tools/bash-operations.js";
import { createLocalBashOperations } from "./tools/bash.js";

export abstract class AgentSessionExecution extends AgentSessionExtensions {
  // =========================================================================
  // Auto-Retry
  // =========================================================================

  /**
   * Check if an error is retryable (overloaded, rate limit, server errors).
   * Context overflow errors are NOT retryable (handled by compaction instead).
   */
  protected isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) {
      return false;
    }

    // Context overflow is handled by compaction, not retry
    const contextWindow = this.model?.contextWindow ?? 0;
    if (isContextOverflow(message, contextWindow)) {
      return false;
    }

    return isRetryableAssistantError(message);
  }

  /**
   * Prepare a retryable error for continuation with exponential backoff.
   * @returns true if the caller should continue the agent, false otherwise
   */
  protected async prepareRetry(message: AssistantMessage): Promise<boolean> {
    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      return false;
    }

    this.retryCount++;

    if (this.retryCount > settings.maxRetries) {
      // Preserve the completed attempt count so post-run handling can emit the final failure.
      this.retryCount--;
      return false;
    }

    const backoffDelayMs = settings.baseDelayMs * 2 ** (this.retryCount - 1);
    const rateLimitWindow = classifyRateLimitWindow(message.errorMessage);
    const retryAfterDelayMs =
      rateLimitWindow.kind === "short" && rateLimitWindow.retryAfterSeconds !== undefined
        ? Math.ceil(rateLimitWindow.retryAfterSeconds * 1000)
        : 0;
    const delayMs = Math.max(backoffDelayMs, retryAfterDelayMs);

    this.emit({
      type: "auto_retry_start",
      attempt: this.retryCount,
      maxAttempts: settings.maxRetries,
      delayMs,
      errorMessage: message.errorMessage || "Unknown error",
    });

    // Remove error message from agent state (keep in session for history)
    const messages = this.agent.state.messages;
    if (messages.at(-1)?.role === "assistant") {
      this.agent.state.messages = messages.slice(0, -1);
    }

    // Wait with exponential backoff (abortable)
    this.retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this.retryAbortController.signal);
    } catch {
      // Aborted during sleep - emit end event so UI can clean up
      const attempt = this.retryCount;
      this.retryCount = 0;
      this.emit({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled",
      });
      return false;
    } finally {
      this.retryAbortController = undefined;
    }

    return true;
  }

  /**
   * Cancel in-progress retry.
   */
  abortRetry(): void {
    this.retryAbortController?.abort();
  }

  /** Whether auto-retry is currently in progress */
  get isRetrying(): boolean {
    return this.retryAbortController !== undefined;
  }

  /** Whether auto-retry is enabled */
  get autoRetryEnabled(): boolean {
    return this.settingsManager.getRetryEnabled();
  }

  /**
   * Toggle auto-retry setting.
   */
  setAutoRetryEnabled(enabled: boolean): void {
    this.settingsManager.setRetryEnabled(enabled);
  }

  // =========================================================================
  // Bash Execution
  // =========================================================================

  /**
   * Execute a bash command.
   * Adds result to agent context and session.
   * @param command The bash command to execute
   * @param onChunk Optional streaming callback for output
   * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
   * @param options.operations Custom BashOperations for remote execution
   */
  async executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; operations?: BashOperations },
  ): Promise<BashResult> {
    this.bashAbortController = new AbortController();

    // Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
    const prefix = this.settingsManager.getShellCommandPrefix();
    const shellPath = this.settingsManager.getShellPath();
    const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

    try {
      const result = await executeBashWithOperations(
        resolvedCommand,
        this.sessionManager.getCwd(),
        options?.operations ?? createLocalBashOperations({ shellPath }),
        {
          onChunk,
          signal: this.bashAbortController.signal,
        },
      );

      this.recordBashResult(command, result, options);
      return result;
    } finally {
      this.bashAbortController = undefined;
    }
  }

  /**
   * Record a bash execution result in session history.
   * Used by executeBash and by extensions that handle bash execution themselves.
   */
  recordBashResult(
    command: string,
    result: BashResult,
    options?: { excludeFromContext?: boolean },
  ): void {
    const bashMessage: BashExecutionMessage = {
      role: "bashExecution",
      command,
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      fullOutputPath: result.fullOutputPath,
      timestamp: Date.now(),
      excludeFromContext: options?.excludeFromContext,
    };

    // If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
    if (this.isStreaming) {
      // Queue for later - will be flushed on agent_end
      this.pendingBashMessages.push(bashMessage);
    } else {
      // Add to agent state immediately
      this.agent.state.messages.push(bashMessage);

      // Save to session
      this.sessionManager.appendMessage(bashMessage);
    }
  }

  /**
   * Cancel running bash command.
   */
  abortBash(): void {
    this.bashAbortController?.abort();
  }

  /** Whether a bash command is currently running */
  get isBashRunning(): boolean {
    return this.bashAbortController !== undefined;
  }

  /** Whether there are pending bash messages waiting to be flushed */
  get hasPendingBashMessages(): boolean {
    return this.pendingBashMessages.length > 0;
  }

  /**
   * Flush pending bash messages to agent state and session.
   * Called after agent turn completes to maintain proper message ordering.
   */
  protected flushPendingBashMessages(): void {
    if (this.pendingBashMessages.length === 0) {
      return;
    }

    for (const bashMessage of this.pendingBashMessages) {
      // Add to agent state
      this.agent.state.messages.push(bashMessage);

      // Save to session
      this.sessionManager.appendMessage(bashMessage);
    }

    this.pendingBashMessages = [];
  }
}
