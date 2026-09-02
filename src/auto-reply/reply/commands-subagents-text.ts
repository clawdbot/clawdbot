/** Text extraction helpers for subagent command output. */
import { extractStoredAssistantText } from "../../agents/tools/chat-history-text.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";

/** Minimal chat message shape used by subagent text extraction. */
export type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

/** Extracts sanitized display text from a subagent chat message. */
export function extractSubagentMessageText(
  message: ChatMessage,
): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  const content = role === "assistant" ? extractStoredAssistantText(message) : message.content;
  const text = extractTextFromChatContent(content);
  return text ? { role, text } : null;
}
