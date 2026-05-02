import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { isSilentReplyText } from "../auto-reply/tokens.js";

const TOOL_RESULT_REAL_CONVERSATION_LOOKBACK = 20;
const NON_CONVERSATION_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "thinking",
  "reasoning",
]);

function hasMeaningfulText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (isSilentReplyText(trimmed)) {
    return false;
  }
  const heartbeat = stripHeartbeatToken(trimmed, { mode: "message" });
  if (heartbeat.didStrip) {
    return heartbeat.text.trim().length > 0;
  }
  return true;
}

export function hasMeaningfulConversationContent(message: AgentMessage): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return hasMeaningfulText(content);
  }
  if (!Array.isArray(content)) {
    return false;
  }
  let sawMeaningfulNonTextBlock = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type !== "text") {
      // Tool-call metadata and internal reasoning blocks do not make a
      // heartbeat-only transcript count as real conversation.
      if (typeof type === "string" && NON_CONVERSATION_BLOCK_TYPES.has(type)) {
        continue;
      }
      sawMeaningfulNonTextBlock = true;
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") {
      continue;
    }
    if (hasMeaningfulText(text)) {
      return true;
    }
  }
  return sawMeaningfulNonTextBlock;
}

export function isRealConversationMessage(
  message: AgentMessage,
  messages: AgentMessage[],
  index: number,
): boolean {
  if (message.role === "user" || message.role === "assistant") {
    return hasMeaningfulConversationContent(message);
  }
  if (message.role !== "toolResult") {
    return false;
  }
  const start = Math.max(0, index - TOOL_RESULT_REAL_CONVERSATION_LOOKBACK);
  for (let i = index - 1; i >= start; i -= 1) {
    const candidate = messages[i];
    if (!candidate || candidate.role !== "user") {
      continue;
    }
    if (hasMeaningfulConversationContent(candidate)) {
      return true;
    }
  }
  return false;
}
