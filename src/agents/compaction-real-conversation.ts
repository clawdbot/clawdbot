import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
  if ((message as { role?: unknown }).role === "custom") {
    const custom = message as { content?: unknown; display?: unknown };
    return custom.display !== false && hasMeaningfulMessageContent(custom.content);
  }
  if ((message as { role?: unknown }).role === "bashExecution") {
    const bash = message as {
      command?: unknown;
      output?: unknown;
      excludeFromContext?: unknown;
    };
    if (bash.excludeFromContext === true) {
      return false;
    }
    const command = typeof bash.command === "string" ? bash.command : "";
    const output = typeof bash.output === "string" ? bash.output : "";
    return hasMeaningfulText(`${command}\n${output}`);
  }
  if ((message as { role?: unknown }).role === "branchSummary") {
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

function isToolResultConversationAnchor(message: AgentMessage): boolean {
  const role = (message as { role?: unknown }).role;
  return (
    (role === "user" ||
      role === "custom" ||
      role === "bashExecution" ||
      role === "branchSummary") &&
    hasMeaningfulConversationContent(message)
  );
}

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
    message.role === "branchSummary"
  ) {
    return hasMeaningfulConversationContent(message);
  }
  if (message.role !== "toolResult") {
    return false;
  }
  const start = Math.max(0, index - TOOL_RESULT_REAL_CONVERSATION_LOOKBACK);
  for (let i = index - 1; i >= start; i -= 1) {
    const candidate = messages[i];
    if (!candidate) {
      continue;
    }
    if (isToolResultConversationAnchor(candidate)) {
      return true;
    }
  }
  return false;
}
