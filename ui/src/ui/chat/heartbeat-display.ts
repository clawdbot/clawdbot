import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripHeartbeatTokenForDisplay(
  raw: string,
  maxAckChars = DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
): { shouldSkip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { shouldSkip: true };
  }
  const strippedMarkup = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "");
  if (!text.includes(HEARTBEAT_TOKEN) && !strippedMarkup.includes(HEARTBEAT_TOKEN)) {
    return { shouldSkip: false };
  }

  const tokenAtEnd = new RegExp(`${escapeRegExp(HEARTBEAT_TOKEN)}[^\\w]{0,4}$`);
  let changed = true;
  let didStrip = false;
  text = strippedMarkup.trim();
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(HEARTBEAT_TOKEN)) {
      text = next.slice(HEARTBEAT_TOKEN.length).trimStart();
      didStrip = true;
      changed = true;
      continue;
    }
    if (tokenAtEnd.test(next)) {
      const index = next.lastIndexOf(HEARTBEAT_TOKEN);
      const before = next.slice(0, index).trimEnd();
      const after = next.slice(index + HEARTBEAT_TOKEN.length).trimStart();
      text = before ? `${before}${after}`.trimEnd() : "";
      didStrip = true;
      changed = true;
    }
  }

  if (!didStrip) {
    return { shouldSkip: false };
  }
  return { shouldSkip: !text || text.length <= maxAckChars };
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

  const content =
    typeof entry.content === "string" || Array.isArray(entry.content) ? entry.content : entry.text;
  const { text, hasVisibleNonTextContent } = resolveDisplayContent(content);
  if (hasVisibleNonTextContent) {
    return false;
  }
  return stripHeartbeatTokenForDisplay(text).shouldSkip;
}
