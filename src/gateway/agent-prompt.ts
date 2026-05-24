import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";

export type ConversationEntry = {
  role: "user" | "assistant" | "tool";
  entry: HistoryEntry;
  internalStreamError?: boolean;
};

/**
 * Coerce body to string. Handles cases where body is a content array
 * (e.g. [{type:"text", text:"hello"}]) that would serialize as
 * [object Object] if used directly in a template literal.
 */
function safeBody(body: unknown): string {
  return typeof body === "string" ? body : (extractTextFromChatContent(body) ?? "");
}

function toPromptEntry(entry: ConversationEntry): HistoryEntry | null {
  const body = safeBody(entry.entry.body);
  if (
    entry.role === "assistant" &&
    entry.internalStreamError === true &&
    body.trim() === STREAM_ERROR_FALLBACK_TEXT
  ) {
    return null;
  }
  return {
    ...entry.entry,
    body,
  };
}

export function buildAgentMessageFromConversationEntries(entries: ConversationEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  // Prefer the last user/tool entry as "current message" so the agent responds to
  // the latest user input or tool output, not the assistant's previous message.
  let currentIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const role = entries[i]?.role;
    if (role === "user" || role === "tool") {
      currentIndex = i;
      break;
    }
  }
  if (currentIndex < 0) {
    currentIndex = entries.length - 1;
  }

  const currentConversationEntry = entries[currentIndex];
  const currentEntry = currentConversationEntry?.entry;
  if (!currentConversationEntry || !currentEntry) {
    return "";
  }

  const historyEntries = entries
    .slice(0, currentIndex)
    .map(toPromptEntry)
    .filter((entry): entry is HistoryEntry => entry !== null);
  const currentPromptEntry = toPromptEntry(currentConversationEntry);
  if (!currentPromptEntry) {
    return "";
  }
  if (historyEntries.length === 0) {
    return currentPromptEntry.body;
  }

  const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${entry.body}`;
  return buildHistoryContextFromEntries({
    entries: [...historyEntries, currentPromptEntry],
    currentMessage: formatEntry(currentPromptEntry),
    formatEntry,
  });
}
