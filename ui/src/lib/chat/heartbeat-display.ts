import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  stripHeartbeatToken,
} from "../../../../src/auto-reply/heartbeat.js";

export function stripHeartbeatTokenForDisplay(
  raw: string,
  maxAckChars = DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
): { shouldSkip: boolean; text: string } {
  const result = stripHeartbeatToken(raw, { mode: "message" });
  const text = result.didStrip && /^[*`~_]+$/.test(result.text) ? "" : result.text;
  return {
    shouldSkip: result.shouldSkip || (result.didStrip && text.length <= maxAckChars),
    text,
  };
}

function isHiddenDisplayBlockType(type: unknown): boolean {
  return type === "thinking" || type === "reasoning";
}

function resolveDisplayContent(content: unknown): {
  text: string;
  hasVisibleNonTextContent: boolean;
} {
  if (typeof content === "string") {
    return { text: content, hasVisibleNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasVisibleNonTextContent: content != null };
  }
  let hasVisibleNonTextContent = false;
  const text = content
    .filter((block): block is { type: "text"; text: string } => {
      if (!block || typeof block !== "object" || !("type" in block)) {
        hasVisibleNonTextContent = true;
        return false;
      }
      if ((block as { type?: unknown }).type !== "text") {
        if (!isHiddenDisplayBlockType((block as { type?: unknown }).type)) {
          hasVisibleNonTextContent = true;
        }
        return false;
      }
      if (typeof (block as { text?: unknown }).text !== "string") {
        hasVisibleNonTextContent = true;
        return false;
      }
      return true;
    })
    .map((block) => block.text)
    .join("");
  return { text, hasVisibleNonTextContent };
}

export function isAssistantHeartbeatAckForDisplay(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "assistant") {
    return false;
  }
  if (typeof entry.senderLabel === "string" && entry.senderLabel.trim()) {
    return false;
  }

  const content =
    typeof entry.content === "string" || Array.isArray(entry.content) ? entry.content : entry.text;
  const { text, hasVisibleNonTextContent } = resolveDisplayContent(content);
  if (hasVisibleNonTextContent) {
    return false;
  }
  return stripHeartbeatTokenForDisplay(text).shouldSkip;
}
