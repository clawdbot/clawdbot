import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { calculateContextTokens, estimateContextTokens } from "../runtime/index.js";
import { AgentSessionModels } from "./agent-session-models.js";
import type { SessionStats } from "./agent-session-types.js";
import {
  estimateMessagesFromContent,
  extractTextContent,
  hasPersistedAssistantContent,
} from "./agent-session-utils.js";
import type { ContextUsage } from "./extensions/index.js";
import { getLatestCompactionEntry, type SessionHeader } from "./session-manager.js";

export abstract class AgentSessionInspection extends AgentSessionModels {
  // =========================================================================
  // Session Management
  // =========================================================================

  /**
   * Set a display name for the current session.
   */
  setSessionName(name: string): void {
    this.sessionManager.appendSessionInfo(name);
    this.emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
  }

  /**
   * Get session statistics.
   */
  getSessionStats(): SessionStats {
    const state = this.state;
    const userMessages = state.messages.filter((m) => m.role === "user").length;
    const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
    const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

    let toolCalls = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const message of state.messages) {
      if (message.role === "assistant") {
        const assistantMsg = message;
        toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
        totalInput += assistantMsg.usage.input;
        totalOutput += assistantMsg.usage.output;
        totalCacheRead += assistantMsg.usage.cacheRead;
        totalCacheWrite += assistantMsg.usage.cacheWrite;
        totalCost += assistantMsg.usage.cost.total;
      }
    }

    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: state.messages.length,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      },
      cost: totalCost,
      contextUsage: this.getContextUsage(),
    };
  }

  getContextUsage(): ContextUsage | undefined {
    const model = this.model;
    if (!model) {
      return undefined;
    }

    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) {
      return undefined;
    }

    // After compaction, the last assistant usage reflects pre-compaction context size.
    // We can only trust usage from an assistant that responded after the latest compaction.
    // If no such assistant exists, context token count is unknown until the next LLM response.
    const branchEntries = this.sessionManager.getBranch();
    const latestCompaction = getLatestCompactionEntry(branchEntries);
    let estimateFromContent = false;

    if (latestCompaction) {
      // Check if there's a valid assistant usage after the compaction boundary
      const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
      let hasPostCompactionUsage = false;
      for (const entry of branchEntries.slice(compactionIndex + 1).toReversed()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
          const assistant = entry.message;
          if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
            if (assistant.usage.contextUsage?.state === "unavailable") {
              estimateFromContent = true;
              continue;
            }
            const contextTokens = calculateContextTokens(assistant.usage);
            if (contextTokens > 0) {
              hasPostCompactionUsage = true;
              estimateFromContent = false;
              break;
            }
          }
        }
      }

      if (!hasPostCompactionUsage && !estimateFromContent) {
        return { tokens: null, contextWindow, percent: null };
      }
    }

    const tokens = estimateFromContent
      ? estimateMessagesFromContent(this.messages)
      : estimateContextTokens(this.messages).tokens;
    const percent = (tokens / contextWindow) * 100;

    return {
      tokens,
      contextWindow,
      percent,
    };
  }

  /**
   * Export the current session branch to a JSONL file.
   * Writes the session header followed by all entries on the current branch path.
   * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
   * @returns The resolved output file path.
   */
  exportToJsonl(outputPath?: string): string {
    const filePath = resolve(
      outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
    );
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionManager.getSessionId(),
      timestamp: new Date().toISOString(),
      cwd: this.sessionManager.getCwd(),
    };

    const branchEntries = this.sessionManager.getBranch();
    const lines = [JSON.stringify(header)];

    // Re-chain parentIds to form a linear sequence
    let prevId: string | null = null;
    for (const entry of branchEntries) {
      const linear = { ...entry, parentId: prevId };
      lines.push(JSON.stringify(linear));
      prevId = entry.id;
    }

    writeFileSync(filePath, `${lines.join("\n")}\n`);
    return filePath;
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  /**
   * Get text content of last assistant message.
   * Useful for /copy command.
   * @returns Text content, or undefined if no assistant message exists
   */
  getLastAssistantText(): string | undefined {
    const lastAssistant = this.messages
      .slice()
      .toReversed()
      .find((m) => {
        if (m.role !== "assistant") {
          return false;
        }
        const content = (m as { content?: unknown }).content;
        if (m.stopReason === "aborted" && !hasPersistedAssistantContent(content)) {
          return false;
        }
        return true;
      });

    if (!lastAssistant) {
      return undefined;
    }

    const content = (lastAssistant as { content?: unknown }).content;
    return extractTextContent(content).trim() || undefined;
  }
}
