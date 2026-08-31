import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
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
  const text: string[] = [];
  content.forEach((block) => {
    const entry = asOptionalObjectRecord(block);
    if (entry?.type === "text" && typeof entry.text === "string") {
      text.push(entry.text);
    } else if (entry?.type !== "thinking" && entry?.type !== "reasoning") {
      hasVisibleNonTextContent = true;
    }
  });
  return { text: text.join(""), hasVisibleNonTextContent };
}

export function isAssistantHeartbeatAckForDisplay(message: unknown): boolean {
  const entry = asOptionalObjectRecord(message);
  if (!entry) {
    return false;
  }
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
