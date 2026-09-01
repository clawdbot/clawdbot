import { stripCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import type { AgentMessage } from "../../types.js";
import {
  asAgentMessage,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type { SessionContext, SessionTreeEntry } from "../types.js";
import { selectResetKeptEntries } from "./tool-result-pairing.js";

const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

/** The same semantic cut is used before payload acquisition and when building messages. */
function resolveSessionContextWindow(
  entries: readonly { id: string; type: string; firstKeptEntryId?: string }[],
): { boundaryIndex: number; firstKeptIndex: number } {
  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.type === "reset" || entry.type === "compaction",
  );
  const firstKeptIndex = entries.findIndex(
    (entry) => entry.id === entries[boundaryIndex]?.firstKeptEntryId,
  );
  return {
    boundaryIndex,
    firstKeptIndex:
      firstKeptIndex >= 0 && firstKeptIndex < boundaryIndex ? firstKeptIndex : boundaryIndex,
  };
}

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

/** Select the canonical window using only navigation and tool-pairing facts. */
export function* iterateSessionContextEntries<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
): Generator<{ entry: T; context: "current" | "retained" | "reset-retained" }> {
  const { boundaryIndex, firstKeptIndex } = resolveSessionContextWindow(pathEntries);
  const boundary = pathEntries[boundaryIndex];
  const resetKept =
    boundary?.type === "reset"
      ? new Set(selectResetKeptEntries(pathEntries.slice(firstKeptIndex, boundaryIndex)))
      : undefined;
  if (boundary) {
    yield { entry: boundary, context: "current" };
  }
  for (const [index, entry] of pathEntries.entries()) {
    const retained = index < boundaryIndex;
    if (
      index === boundaryIndex ||
      (retained && (index < firstKeptIndex || (resetKept && !resetKept.has(entry))))
    ) {
      continue;
    }
    const hasMessage =
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary";
    if (
      !hasMessage ||
      (!resetKept?.has(entry) &&
        entry.type === "message" &&
        "excludeFromContext" in entry.message &&
        entry.message.excludeFromContext === true)
    ) {
      continue;
    }
    const context = retained ? (resetKept ? "reset-retained" : "retained") : "current";
    yield { entry, context };
  }
}

/** Hydrate selected messages lazily so bounded consumers can stop before later payloads. */
export function* iterateSessionContextMessages<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
  readEntry: (entry: T) => SessionTreeEntry = (entry) => entry,
): Generator<AgentMessage> {
  for (const { entry, context } of iterateSessionContextEntries(pathEntries)) {
    if (entry.type === "reset") {
      continue;
    }
    const hydrated = readEntry(entry);
    if (hydrated.type === "branch_summary" && !hydrated.summary) {
      continue;
    }
    // Explicit reset retention can include otherwise excluded user/assistant messages.
    let message =
      context === "reset-retained" && hydrated.type === "message"
        ? hydrated.message
        : projectSessionEntryMessage(hydrated);
    if (!message) {
      continue;
    }
    if (context !== "current" && message.role === "assistant") {
      message = stripCompactionReplayCheckpoint(message);
    }
    if (context === "reset-retained" && (message.role === "user" || message.role === "assistant")) {
      message = { ...message };
      Object.defineProperty(message, SESSION_HISTORY_PRELUDE, {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }
    yield message;
  }
}

/** Build model context from an ordered session branch and its latest state markers. */
export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { messages: Array.from(iterateSessionContextMessages(pathEntries)), thinkingLevel, model };
}
