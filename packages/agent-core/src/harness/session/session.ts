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

function appendContextMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (entry.type === "message") {
    messages.push(entry.message);
  } else if (entry.type === "custom_message") {
    messages.push(
      asAgentMessage(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      ),
    );
  } else if (entry.type === "branch_summary" && entry.summary) {
    messages.push(
      asAgentMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)),
    );
  }
}

function appendResetKeptMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (
    entry.type === "message" &&
    (entry.message.role === "user" || entry.message.role === "assistant")
  ) {
    const message = { ...entry.message } as AgentMessage & { [SESSION_HISTORY_PRELUDE]?: true };
    Object.defineProperty(message, SESSION_HISTORY_PRELUDE, {
      configurable: true,
      enumerable: false,
      value: true,
    });
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
      messages.push(
        asAgentMessage(
          createCompactionSummaryMessage(
            boundary.summary,
            boundary.tokensBefore,
            boundary.timestamp,
          ),
        ),
      );
    }
    const boundaryIdx = pathEntries.findIndex((entry) => entry.id === boundary.id);
    // A reset kept tail mirrors the old cross-log replay contract: only user/assistant
    // rows survive. Compaction keeps its existing richer retained-tail behavior.
    let foundFirstKept = false;
    for (const entry of pathEntries.slice(0, boundaryIdx)) {
      if (entry.id === boundary.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        if (boundary.type === "reset") {
          appendResetKeptMessage(messages, entry);
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
