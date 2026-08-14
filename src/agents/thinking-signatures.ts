import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "./runtime/index.js";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

export function isThinkingBlock(block: AssistantContentBlock): boolean {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    ((block as { type?: unknown }).type === "thinking" ||
      (block as { type?: unknown }).type === "redacted_thinking")
  );
}

function stripSignatureFieldsFromThinkingBlock(
  block: AssistantContentBlock,
): AssistantContentBlock {
  const record = block as unknown as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "thinkingSignature" || key === "signature" || key === "thought_signature") {
      continue;
    }
    // data is the signature payload for redacted_thinking blocks
    if (key === "data" && record.type === "redacted_thinking") {
      continue;
    }
    stripped[key] = record[key];
  }
  return stripped as unknown as AssistantContentBlock;
}

function stripThinkingSignaturesFromMessage(message: AgentMessage): AgentMessage {
  if (!isAssistantMessageWithContent(message)) {
    return message;
  }
  let changed = false;
  const newContent: AssistantContentBlock[] = [];
  for (const block of message.content) {
    if (!isThinkingBlock(block)) {
      newContent.push(block);
      continue;
    }
    const record = block as unknown as Record<string, unknown>;
    const hasSignature =
      record.thinkingSignature != null ||
      record.signature != null ||
      record.thought_signature != null ||
      (record.type === "redacted_thinking" && record.data != null);
    if (!hasSignature) {
      newContent.push(block);
      continue;
    }
    newContent.push(stripSignatureFieldsFromThinkingBlock(block));
    changed = true;
  }
  return changed ? { ...message, content: newContent } : message;
}

/**
 * Strip signatures from assistant messages generated before the latest compaction.
 * Their signatures are bound to the replaced prompt prefix and cannot be replayed.
 */
export function stripStaleThinkingSignaturesForCompactionReplay(
  messages: AgentMessage[],
): AgentMessage[] {
  let latestCompactionTimestamp: number | null = null;
  for (const message of messages) {
    if (message.role !== "compactionSummary") {
      continue;
    }
    const timestamp = parseDateFirstTimestampMs(message.timestamp);
    if (timestamp !== undefined) {
      latestCompactionTimestamp =
        latestCompactionTimestamp === null
          ? timestamp
          : Math.max(latestCompactionTimestamp, timestamp);
    }
  }
  if (latestCompactionTimestamp === null) {
    return messages;
  }

  let touched = false;
  const out = messages.map((message) => {
    if (!isAssistantMessageWithContent(message)) {
      return message;
    }
    const timestamp = parseDateFirstTimestampMs(message.timestamp);
    if (timestamp === undefined || timestamp >= latestCompactionTimestamp) {
      return message;
    }
    const stripped = stripThinkingSignaturesFromMessage(message);
    touched ||= stripped !== message;
    return stripped;
  });
  return touched ? out : messages;
}
