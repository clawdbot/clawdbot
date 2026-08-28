import { stripCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import type { AgentMessage } from "../../types.js";
import {
  asAgentMessage,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type { CompactionEntry, ResetEntry, SessionContext, SessionTreeEntry } from "../types.js";
import { selectResetKeptEntries } from "./tool-result-pairing.js";

type ContextBoundary = CompactionEntry | ResetEntry;
const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

/** Project persisted session entries into the message shared by replay and summarization. */
export function projectSessionEntryMessage(entry: SessionTreeEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "message":
      // Display-only history stays persisted but never enters replay or summarization.
      return "excludeFromContext" in entry.message && entry.message.excludeFromContext === true
        ? undefined
        : entry.message;
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

function stripStalePrefixReplay(message: AgentMessage): AgentMessage {
  return message.role === "assistant" ? stripCompactionReplayCheckpoint(message) : message;
}

function appendContextMessage(
  messages: AgentMessage[],
  entry: SessionTreeEntry,
  options?: { prefixWasRewritten?: boolean },
): void {
  if (entry.type === "compaction" || (entry.type === "branch_summary" && !entry.summary)) {
    return;
  }
  const message = projectSessionEntryMessage(entry);
  if (message) {
    messages.push(options?.prefixWasRewritten ? stripStalePrefixReplay(message) : message);
  }
}

function appendResetKeptMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (entry.type !== "message") {
    return;
  }
  if (entry.message.role === "user" || entry.message.role === "assistant") {
    const message = { ...stripStalePrefixReplay(entry.message) } as AgentMessage & {
      [SESSION_HISTORY_PRELUDE]?: true;
    };
    Object.defineProperty(message, SESSION_HISTORY_PRELUDE, {
      configurable: true,
      enumerable: false,
      value: true,
    });
    messages.push(message);
  } else if (entry.message.role === "toolResult") {
    messages.push(entry.message);
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
    const firstKeptIdx = pathEntries.findIndex((entry) => entry.id === boundary.firstKeptEntryId);
    const keptEntries =
      firstKeptIdx >= 0 && firstKeptIdx < boundaryIdx
        ? pathEntries.slice(firstKeptIdx, boundaryIdx)
        : [];
    const replayEntries =
      boundary.type === "reset" ? selectResetKeptEntries(keptEntries) : keptEntries;
    // Both retained-tail forms follow rewritten prefixes, so prefix-bound checkpoints are stale.
    for (const entry of replayEntries) {
      if (boundary.type === "reset") {
        appendResetKeptMessage(messages, entry);
      } else {
        appendContextMessage(messages, entry, { prefixWasRewritten: true });
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
