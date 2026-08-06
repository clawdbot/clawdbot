import type { AgentMessage } from "../../types.js";
import {
  asAgentMessage,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type { CompactionEntry, ResetEntry, SessionContext, SessionTreeEntry } from "../types.js";

type ContextBoundary = CompactionEntry | ResetEntry;
const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

/** Project persisted session entries into the message shared by replay and summarization. */
export function projectSessionEntryMessage(entry: SessionTreeEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "message":
      return entry.message;
    case "custom_message":
      return asAgentMessage(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      );
    case "branch_summary":
      return asAgentMessage(
        createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp),
      );
    case "compaction":
      return asAgentMessage(
        createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
      );
    default:
      return undefined;
  }
}

function appendContextMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (entry.type === "compaction" || (entry.type === "branch_summary" && !entry.summary)) {
    return;
  }
  const message = projectSessionEntryMessage(entry);
  if (message) {
    messages.push(message);
  }
}

/** Select reset-tail entries that are safe to replay into model-visible context. */
export function selectResetKeptEntries(entries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
  const pendingToolCalls = new Map<string, number>();
  const retainedEntries: SessionTreeEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }

    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") {
          continue;
        }
        pendingToolCalls.set(block.id, (pendingToolCalls.get(block.id) ?? 0) + 1);
      }
      retainedEntries.push(entry);
      continue;
    }

    if (message.role === "user") {
      retainedEntries.push(entry);
      continue;
    }

    if (message.role === "toolResult") {
      const pendingCount = pendingToolCalls.get(message.toolCallId) ?? 0;
      if (pendingCount === 0) {
        continue;
      }
      if (pendingCount === 1) {
        pendingToolCalls.delete(message.toolCallId);
      } else {
        pendingToolCalls.set(message.toolCallId, pendingCount - 1);
      }
      retainedEntries.push(entry);
    }
  }

  return retainedEntries;
}

function appendResetKeptMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (entry.type !== "message") {
    return;
  }

  const message = entry.message;
  if (message.role === "user" || message.role === "assistant") {
    const retainedMessage = { ...message } as AgentMessage & {
      [SESSION_HISTORY_PRELUDE]?: true;
    };
    Object.defineProperty(retainedMessage, SESSION_HISTORY_PRELUDE, {
      configurable: true,
      enumerable: false,
      value: true,
    });
    messages.push(retainedMessage);
    return;
  }

  if (message.role === "toolResult") {
    messages.push(message);
  }
}

/** Build model context from an ordered session branch and its latest state markers. */
export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  let boundary: ContextBoundary | null = null;

  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    } else if (entry.type === "compaction" || entry.type === "reset") {
      boundary = entry;
    }
  }

  const messages: AgentMessage[] = [];
  if (boundary) {
    if (boundary.type === "compaction") {
      const summary = projectSessionEntryMessage(boundary);
      if (summary) {
        messages.push(summary);
      }
    }
    const boundaryIdx = pathEntries.findIndex((entry) => entry.id === boundary.id);
    let foundFirstKept = false;
    const entriesBeforeBoundary = pathEntries.slice(0, boundaryIdx);
    const firstKeptEntryIndex = entriesBeforeBoundary.findIndex(
      (entry) => entry.id === boundary.firstKeptEntryId,
    );
    const resetKeptEntries =
      boundary.type === "reset" && firstKeptEntryIndex >= 0
        ? selectResetKeptEntries(entriesBeforeBoundary.slice(firstKeptEntryIndex))
        : undefined;
    for (const entry of entriesBeforeBoundary) {
      if (entry.id === boundary.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        if (boundary.type === "reset") {
          // A reset kept tail is a model-context projection: retain user/assistant rows and only
          // tool results paired with retained assistant tool calls. Display/history projections
          // keep their separate user/assistant-only visibility contract.
          if (resetKeptEntries?.includes(entry)) {
            appendResetKeptMessage(messages, entry);
          }
        } else {
          appendContextMessage(messages, entry);
        }
      }
    }
    for (const entry of pathEntries.slice(boundaryIdx + 1)) {
      appendContextMessage(messages, entry);
    }
  } else {
    for (const entry of pathEntries) {
      appendContextMessage(messages, entry);
    }
  }

  return { messages, thinkingLevel, model };
}
