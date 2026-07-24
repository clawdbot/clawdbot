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
const COMPACTION_RETAINED_BOUNDARY = Symbol.for("openclaw.compactionRetainedBoundary");
// This enumerable field is runtime-only provenance for context-engine assembly. It is
// removed at the LLM/transcript boundaries and must never be treated as transcript data.
const COMPACTION_SOURCE_ENTRY_ID = "__openclawCompactionSourceEntryId";

function withCompactionSourceEntryId<TMessage extends AgentMessage>(
  message: TMessage,
  entryId: string,
): TMessage {
  const marked = { ...message } as TMessage & { [COMPACTION_SOURCE_ENTRY_ID]?: string };
  Object.defineProperty(marked, COMPACTION_SOURCE_ENTRY_ID, {
    configurable: true,
    enumerable: true,
    value: entryId,
  });
  return marked;
}

function withCompactionRetainedBoundary<TMessage extends AgentMessage>(
  message: TMessage,
  boundaryId: string,
): TMessage {
  const marked = { ...message } as TMessage & { [COMPACTION_RETAINED_BOUNDARY]?: string };
  Object.defineProperty(marked, COMPACTION_RETAINED_BOUNDARY, {
    configurable: true,
    enumerable: true,
    value: boundaryId,
  });
  return marked;
}

function appendContextMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (entry.type === "message") {
    messages.push(withCompactionSourceEntryId(entry.message, entry.id));
  } else if (entry.type === "custom_message") {
    messages.push(
      withCompactionSourceEntryId(
        asAgentMessage(
          createCustomMessage(
            entry.customType,
            entry.content,
            entry.display,
            entry.details,
            entry.timestamp,
          ),
        ),
        entry.id,
      ),
    );
  } else if (entry.type === "branch_summary" && entry.summary) {
    messages.push(
      withCompactionSourceEntryId(
        asAgentMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)),
        entry.id,
      ),
    );
  }
}

function appendResetKeptMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (
    entry.type === "message" &&
    (entry.message.role === "user" || entry.message.role === "assistant")
  ) {
    const message = withCompactionSourceEntryId(entry.message, entry.id) as AgentMessage & {
      [SESSION_HISTORY_PRELUDE]?: true;
    };
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
    let compactionSummary: Extract<AgentMessage, { role: "compactionSummary" }> | undefined;
    if (boundary.type === "compaction") {
      compactionSummary = withCompactionRetainedBoundary(
        withCompactionSourceEntryId(
          asAgentMessage(
            createCompactionSummaryMessage(
              boundary.summary,
              boundary.tokensBefore,
              boundary.timestamp,
            ),
          ),
          boundary.id,
        ) as Extract<AgentMessage, { role: "compactionSummary" }>,
        boundary.id,
      );
      messages.push(compactionSummary);
    }
    const retainedMessagesStart = messages.length;
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
    if (compactionSummary) {
      // The summary is intentionally first in model context. Preserve the source boundary
      // on each retained message so filtering/windowing cannot make positional metadata stale.
      for (let index = retainedMessagesStart; index < messages.length; index += 1) {
        const message = messages[index];
        if (message) {
          messages[index] = withCompactionRetainedBoundary(message, boundary.id);
        }
      }
      compactionSummary.retainedMessageCount = messages.length - retainedMessagesStart;
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
