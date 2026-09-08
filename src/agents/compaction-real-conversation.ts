/**
 * Classifies transcript messages that contain real user-visible conversation
 * for compaction and history pruning.
 */
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { isSilentReplyText } from "../auto-reply/tokens.js";
import type { AgentMessage } from "./runtime/index.js";

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
  if (!trimmed || isSilentReplyText(trimmed)) {
    return false;
  }
  const heartbeat = stripHeartbeatToken(trimmed, { mode: "message" });
  return !heartbeat.didStrip || heartbeat.text.trim().length > 0;
}

function isSummaryRole(role: unknown): boolean {
  return role === "branchSummary" || role === "compactionSummary";
}

/** Returns whether a message has content worth preserving as conversation. */
function hasMeaningfulConversationContent(message: AgentMessage): boolean {
  if ("excludeFromContext" in message && message.excludeFromContext === true) {
    return false;
  }
  if ((message as { role?: unknown }).role === "custom") {
    const custom = message as { content?: unknown; display?: unknown };
    return custom.display !== false && hasMeaningfulMessageContent(custom.content);
  }
  if ((message as { role?: unknown }).role === "bashExecution") {
    const bash = message as {
      command?: unknown;
      output?: unknown;
    };
    const command = typeof bash.command === "string" ? bash.command : "";
    const output = typeof bash.output === "string" ? bash.output : "";
    return hasMeaningfulText(`${command}\n${output}`);
  }
  if (isSummaryRole((message as { role?: unknown }).role)) {
    const summary = (message as { summary?: unknown }).summary;
    return typeof summary === "string" && hasMeaningfulText(summary);
  }
  const content = (message as { content?: unknown }).content;
  return hasMeaningfulMessageContent(content);
}

function hasMeaningfulMessageContent(content: unknown): boolean {
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
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text") {
      if (typeof text === "string" && hasMeaningfulText(text)) {
        return true;
      }
    } else if (typeof type !== "string" || !NON_CONVERSATION_BLOCK_TYPES.has(type)) {
      // Tool-call metadata and internal reasoning blocks do not make a
      // heartbeat-only transcript count as real conversation.
      sawMeaningfulNonTextBlock = true;
    }
  }
  return sawMeaningfulNonTextBlock;
}

function isToolResultConversationAnchor(message: AgentMessage): boolean {
  const role = (message as { role?: unknown }).role;
  return (
    (role === "user" || role === "custom" || role === "bashExecution" || isSummaryRole(role)) &&
    hasMeaningfulConversationContent(message)
  );
}

/** Returns whether a transcript message should count as real conversation. */
export function isRealConversationMessage(
  message: AgentMessage,
  messages: AgentMessage[],
  index: number,
): boolean {
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "custom" ||
    message.role === "bashExecution" ||
    isSummaryRole(message.role)
  ) {
    return hasMeaningfulConversationContent(message);
  }
  if (message.role !== "toolResult") {
    return false;
  }
  const start = Math.max(0, index - TOOL_RESULT_REAL_CONVERSATION_LOOKBACK);
  for (let i = index - 1; i >= start; i -= 1) {
    const candidate = messages[i];
    if (candidate && isToolResultConversationAnchor(candidate)) {
      return true;
    }
  }
  return false;
}
