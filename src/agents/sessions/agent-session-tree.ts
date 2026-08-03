import {
  collectEntriesForBranchSummaryFromBranches,
  generateBranchSummary,
} from "../runtime/index.js";
import { AgentSessionExecution } from "./agent-session-execution.js";
import { extractTextContent, normalizeBranchSummaryResult } from "./agent-session-utils.js";
import type {
  ExtensionRunner,
  ReplacedSessionContext,
  TreePreparation,
} from "./extensions/index.js";
import type { BranchSummaryEntry } from "./session-manager.js";

export abstract class AgentSessionTree extends AgentSessionExecution {
  // =========================================================================
  // Tree Navigation
  // =========================================================================

  /**
   * Navigate to a different node in the session tree.
   * Unlike fork() which creates a new session file, this stays in the same file.
   *
   * @param targetId The entry ID to navigate to
   * @param options.summarize Whether user wants to summarize abandoned branch
   * @param options.customInstructions Custom instructions for summarizer
   * @param options.replaceInstructions If true, customInstructions replaces the default prompt
   * @param options.label Label to attach to the branch summary entry
   * @returns Result with editorText (if user message) and cancelled status
   */
  async navigateTree(
    targetId: string,
    options: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    } = {},
  ): Promise<{
    editorText?: string;
    cancelled: boolean;
    aborted?: boolean;
    summaryEntry?: BranchSummaryEntry;
  }> {
    const oldLeafId = this.sessionManager.getLeafId();

    // No-op if already at target
    if (targetId === oldLeafId) {
      return { cancelled: false };
    }

    // Model required for summarization
    if (options.summarize && !this.model) {
      throw new Error("No model available for summarization");
    }

    const targetEntry = this.sessionManager.getEntry(targetId);
    if (!targetEntry) {
      throw new Error(`Entry ${targetId} not found`);
    }

    // Collect entries to summarize (from old leaf to common ancestor)
    const { entries: entriesToSummarize, commonAncestorId } = oldLeafId
      ? collectEntriesForBranchSummaryFromBranches(
          this.sessionManager.getBranch(oldLeafId),
          this.sessionManager.getBranch(targetId),
        )
      : { entries: [], commonAncestorId: null };

    // Prepare event data - mutable so extensions can override
    let customInstructions = options.customInstructions;
    let replaceInstructions = options.replaceInstructions;
    let label = options.label;

    const preparation: TreePreparation = {
      targetId,
      oldLeafId,
      commonAncestorId,
      entriesToSummarize,
      userWantsSummary: options.summarize ?? false,
      customInstructions,
      replaceInstructions,
      label,
    };

    // Set up abort controller for summarization
    this.branchSummaryAbortController = new AbortController();

    try {
      let extensionSummary: { summary: string; details?: unknown } | undefined;
      let fromExtension = false;

      // Emit session_before_tree event
      if (this.currentExtensionRunner.hasHandlers("session_before_tree")) {
        const result = await this.currentExtensionRunner.emit({
          type: "session_before_tree",
          preparation,
          signal: this.branchSummaryAbortController.signal,
        });

        if (result?.cancel) {
          return { cancelled: true };
        }

        if (result?.summary && options.summarize) {
          extensionSummary = result.summary;
          fromExtension = true;
        }

        // Allow extensions to override instructions and label
        if (result?.customInstructions !== undefined) {
          customInstructions = result.customInstructions;
        }
        if (result?.replaceInstructions !== undefined) {
          replaceInstructions = result.replaceInstructions;
        }
        if (result?.label !== undefined) {
          label = result.label;
        }
      }

      // Run default summarizer if needed
      let summaryText: string | undefined;
      let summaryDetails: unknown;
      if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
        const model = this.model!;
        const { apiKey, headers } = await this.getRequiredRequestAuth(model);
        const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
        const result = normalizeBranchSummaryResult(
          await generateBranchSummary(entriesToSummarize, {
            model,
            apiKey,
            headers,
            signal: this.branchSummaryAbortController.signal,
            customInstructions,
            replaceInstructions,
            reserveTokens: branchSummarySettings.reserveTokens,
            streamFn: this.agent.streamFn,
          }),
        );
        if (result.aborted) {
          return { cancelled: true, aborted: true };
        }
        if (result.error) {
          throw new Error(result.error);
        }
        summaryText = result.summary;
        summaryDetails = {
          readFiles: result.readFiles || [],
          modifiedFiles: result.modifiedFiles || [],
        };
      } else if (extensionSummary) {
        summaryText = extensionSummary.summary;
        summaryDetails = extensionSummary.details;
      }

      // Determine the new leaf position based on target type
      let newLeafId: string | null;
      let editorText: string | undefined;

      if (targetEntry.type === "message" && targetEntry.message.role === "user") {
        // User message: leaf = parent (null if root), text goes to editor
        newLeafId = targetEntry.parentId;
        editorText = extractTextContent(targetEntry.message.content);
      } else if (targetEntry.type === "custom_message") {
        // Custom message: leaf = parent (null if root), text goes to editor
        newLeafId = targetEntry.parentId;
        editorText = extractTextContent(targetEntry.content);
      } else {
        // Non-user message: leaf = selected node
        newLeafId = targetId;
      }

      // Switch leaf (with or without summary)
      // Summary is attached at the navigation target position (newLeafId), not the old branch
      let summaryEntry: BranchSummaryEntry | undefined;
      if (summaryText) {
        // Create summary at target position (can be null for root)
        const summaryId = this.sessionManager.branchWithSummary(
          newLeafId,
          summaryText,
          summaryDetails,
          fromExtension,
        );
        summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

        // Attach label to the summary entry
        if (label) {
          this.sessionManager.appendLabelChange(summaryId, label);
        }
      } else if (newLeafId === null) {
        // No summary, navigating to root - reset leaf
        this.sessionManager.resetLeaf();
      } else {
        // No summary, navigating to non-root
        this.sessionManager.branch(newLeafId);
      }

      // Attach label to target entry when not summarizing (no summary entry to label)
      if (label && !summaryText) {
        this.sessionManager.appendLabelChange(targetId, label);
      }

      // Update agent state
      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.state.messages = sessionContext.messages;

      // Emit session_tree event
      await this.currentExtensionRunner.emit({
        type: "session_tree",
        newLeafId: this.sessionManager.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromExtension: summaryText ? fromExtension : undefined,
      });

      // Emit to custom tools

      return { editorText, cancelled: false, summaryEntry };
    } finally {
      this.branchSummaryAbortController = undefined;
    }
  }

  /**
   * Get all user messages from session for fork selector.
   */
  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    const entries = this.sessionManager.getEntries();
    const result: Array<{ entryId: string; text: string }> = [];

    for (const entry of entries) {
      if (entry.type !== "message") {
        continue;
      }
      if (entry.message.role !== "user") {
        continue;
      }

      const text = extractTextContent(entry.message.content);
      if (text) {
        result.push({ entryId: entry.id, text });
      }
    }

    return result;
  }

  // =========================================================================
  // Extension System
  // =========================================================================

  createReplacedSessionContext(): ReplacedSessionContext {
    const context = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(this.currentExtensionRunner.createCommandContext()),
    ) as ReplacedSessionContext;
    context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
    context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
    return context;
  }

  /**
   * Check if extensions have handlers for a specific event type.
   */
  hasExtensionHandlers(eventType: string): boolean {
    return this.currentExtensionRunner.hasHandlers(eventType);
  }

  /**
   * Get the extension runner (for setting UI context and error handlers).
   */
  get extensionRunner(): ExtensionRunner {
    return this.currentExtensionRunner;
  }
}
