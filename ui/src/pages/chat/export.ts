// Control UI chat module implements export behavior.
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { extractTextCached } from "../../lib/chat/message-extract.ts";

/**
 * Export chat history as markdown file.
 */
export function exportChatMarkdown(messages: unknown[], assistantName: string): void {
  const markdown = buildChatMarkdown(messages, assistantName);
  if (!markdown) {
    return;
  }
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chat-${assistantName}-${Date.now()}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function buildChatMarkdown(messages: unknown[], assistantName: string): string | null {
  const history = Array.isArray(messages) ? messages : [];
  if (history.length === 0) {
    return null;
  }
  const lines: string[] = [`# Chat with ${assistantName}`, ""];
  for (const msg of history) {
    const m = msg as Record<string, unknown>;
    const role = m.role === "user" ? "You" : m.role === "assistant" ? assistantName : "Tool";
    const content = extractTextCached(msg) ?? "";
    const ts = timestampMsToIsoString(m.timestamp) ?? "";
    lines.push(`## ${role}${ts ? ` (${ts})` : ""}`, "", content, "");
  }
  return lines.join("\n");
}
