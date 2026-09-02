import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CodexThreadItem } from "./app-server/protocol.js";
import { projectCodexUserItemText } from "./app-server/transcript-history-projection.js";

// A single Codex tool item embeds its whole command payload — one observed `rg`
// run carried 2.4 MB — while every consumer (chat transcript, history import)
// shows a preview. Page limits bound item count, never the bytes inside one
// item, so the preview bound belongs here at the producer. 4 KiB is roughly
// fifty output lines: enough to read what the command did, and small enough
// that a full page of tool items stays well under the page byte budget.
const TOOL_TEXT_PREVIEW_BYTES = 4096;

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
  const text =
    item.type === "userMessage"
      ? projectCodexUserItemText(item)
      : item.text || resultText || changesText || fallback;
  const preview =
    (type === "toolCall" || type === "toolResult") && text
      ? truncateUtf8Prefix(text, TOOL_TEXT_PREVIEW_BYTES)
      : text;
  return {
    id: item.id,
    type,
    ...(preview ? { text: preview } : {}),
    ...(preview === text ? {} : { truncated: true }),
  };
}
