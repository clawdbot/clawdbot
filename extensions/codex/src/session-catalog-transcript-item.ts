import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import type { CodexThreadItem } from "./app-server/protocol.js";

const CODEX_MESSAGE_TYPES = new Map<string, SessionCatalogTranscriptItem["type"]>([
  ["userMessage", "userMessage"],
  ["agentMessage", "agentMessage"],
  ["reasoning", "reasoning"],
]);

const CODEX_TOOL_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

export function toGenericTranscriptItem(item: CodexThreadItem): SessionCatalogTranscriptItem {
  let type = CODEX_MESSAGE_TYPES.get(item.type);
  if (!type && CODEX_TOOL_TYPES.has(item.type)) {
    const hasResult = item.result !== undefined || Boolean(item.aggregatedOutput);
    type = hasResult ? "toolResult" : "toolCall";
  }
  type ??= "other";
  const fallback = item.title ?? item.name ?? item.tool ?? item.command ?? item.query ?? undefined;
  const resultText =
    item.aggregatedOutput ||
    (item.result === undefined ? undefined : JSON.stringify(item.result, null, 2));
  // File changes carry only a changes array; keep their edits visible.
  const changesText = Array.isArray(item.changes)
    ? item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n") || undefined
    : undefined;
  const text = item.text || resultText || changesText || fallback;
  return {
    id: item.id,
    type,
    ...(text ? { text } : {}),
    raw: item as SessionCatalogTranscriptItem["raw"],
  };
}
