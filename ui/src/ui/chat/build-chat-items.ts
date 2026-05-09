import type { ChatItem, MessageGroup, ToolCard } from "../types/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "./heartbeat-display.ts";
import { CHAT_HISTORY_RENDER_LIMIT } from "./history-limits.ts";
import { extractTextCached } from "./message-extract.ts";
import { normalizeMessage, stripMessageDisplayMetadataText } from "./message-normalizer.ts";
import { normalizeRoleForGrouping } from "./role-normalizer.ts";
import { messageMatchesSearchQuery } from "./search-match.ts";
import { extractToolCards, extractToolPreview } from "./tool-cards.ts";

export type BuildChatItemsProps = {
  sessionKey: string;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
  stream: string | null;
  streamStartedAt: number | null;
  showToolCalls: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
};

function appendCanvasBlockToAssistantMessage(
  message: unknown,
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
  rawText: string | null,
) {
  const raw = message as Record<string, unknown>;
  const existingContent = Array.isArray(raw.content)
    ? [...raw.content]
    : typeof raw.content === "string"
      ? [{ type: "text", text: raw.content }]
      : typeof raw.text === "string"
        ? [{ type: "text", text: raw.text }]
        : [];
  const alreadyHasArtifact = existingContent.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as {
      type?: unknown;
      preview?: { kind?: unknown; viewId?: unknown; url?: unknown };
    };
    return (
      typed.type === "canvas" &&
      typed.preview?.kind === "canvas" &&
      ((preview.viewId && typed.preview.viewId === preview.viewId) ||
        (preview.url && typed.preview.url === preview.url))
    );
  });
  if (alreadyHasArtifact) {
    return message;
  }
  return {
    ...raw,
    content: [
      ...existingContent,
      {
        type: "canvas",
        preview,
        ...(rawText ? { rawText } : {}),
      },
    ],
  };
}

function extractChatMessagePreview(toolMessage: unknown): {
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
  text: string | null;
  timestamp: number | null;
} | null {
  const normalized = normalizeMessage(toolMessage);
  const cards = extractToolCards(toolMessage, "preview");
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === "canvas") {
      return {
        preview: card.preview,
        text: card.outputText ?? null,
        timestamp: normalized.timestamp ?? null,
      };
    }
  }
  const text = extractTextCached(toolMessage) ?? undefined;
  const toolRecord = toolMessage as Record<string, unknown>;
  const toolName =
    typeof toolRecord.toolName === "string"
      ? toolRecord.toolName
      : typeof toolRecord.tool_name === "string"
        ? toolRecord.tool_name
        : undefined;
  const preview = extractToolPreview(text, toolName);
  if (preview?.kind !== "canvas") {
    return null;
  }
  return { preview, text: text ?? null, timestamp: normalized.timestamp ?? null };
}

function findNearestAssistantMessageIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
): number | null {
  const assistantEntries = items
    .map((item, index) => {
      if (item.kind !== "message") {
        return null;
      }
      const message = item.message as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
      if (role !== "assistant") {
        return null;
      }
      return {
        index,
        timestamp: normalizeMessage(item.message).timestamp ?? null,
      };
    })
    .filter(Boolean) as Array<{ index: number; timestamp: number | null }>;
  if (assistantEntries.length === 0) {
    return null;
  }
  if (toolTimestamp == null) {
    return assistantEntries[assistantEntries.length - 1]?.index ?? null;
  }
  let previous: { index: number; timestamp: number } | null = null;
  let next: { index: number; timestamp: number } | null = null;
  for (const entry of assistantEntries) {
    if (entry.timestamp == null) {
      continue;
    }
    if (entry.timestamp <= toolTimestamp) {
      previous = { index: entry.index, timestamp: entry.timestamp };
      continue;
    }
    next = { index: entry.index, timestamp: entry.timestamp };
    break;
  }
  if (previous && next) {
    const previousDelta = toolTimestamp - previous.timestamp;
    const nextDelta = next.timestamp - toolTimestamp;
    return nextDelta < previousDelta ? next.index : previous.index;
  }
  if (previous) {
    return previous.index;
  }
  if (next) {
    return next.index;
  }
  return assistantEntries[assistantEntries.length - 1]?.index ?? null;
}

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel = role.toLowerCase() === "user" ? (normalized.senderLabel ?? null) : null;
    const timestamp = normalized.timestamp || Date.now();

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (role.toLowerCase() === "user" && currentGroup.senderLabel !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        messages: [{ message: item.message, key: item.key, duplicateCount: item.duplicateCount }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({
        message: item.message,
        key: item.key,
        duplicateCount: item.duplicateCount,
      });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function collapseDuplicateDisplaySignature(message: unknown): string | null {
  const normalized = normalizeMessage(message);
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (!role || role === "tool") {
    return null;
  }
  if (normalized.content.length === 0) {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    textParts.push(block.text);
  }
  const text = textParts.join("\n").trim().replace(/\s+/g, " ");
  if (!text) {
    return null;
  }
  const senderLabel = role === "user" ? (normalized.senderLabel ?? "").trim() : "";
  return `${role}:${senderLabel}:${text}`;
}

function collapseSequentialDuplicateMessages(items: ChatItem[]): ChatItem[] {
  const collapsed: ChatItem[] = [];
  let previousSignature: string | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      collapsed.push(item);
      previousSignature = null;
      continue;
    }
    const signature = collapseDuplicateDisplaySignature(item.message);
    const previous = collapsed[collapsed.length - 1];
    if (signature && previousSignature === signature && previous?.kind === "message") {
      previous.duplicateCount = (previous.duplicateCount ?? 1) + 1;
      continue;
    }
    collapsed.push(item);
    previousSignature = signature;
  }

  return collapsed;
}

function hasRenderableNormalizedMessage(message: unknown): boolean {
  const normalized = normalizeMessage(message);
  return normalized.content.length > 0 || Boolean(normalized.replyTarget);
}

function sanitizeStreamText(text: string): string {
  const stripped = stripMessageDisplayMetadataText(text);
  return stripped.trim().length > 0 ? stripped : "";
}

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const history = (Array.isArray(props.messages) ? props.messages : []).filter(
    (message) => !isAssistantHeartbeatAckForDisplay(message),
  );
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const liftedCanvasSources = tools
    .map((tool) => extractChatMessagePreview(tool))
    .filter((entry) => Boolean(entry)) as Array<{
    preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
    text: string | null;
    timestamp: number | null;
  }>;
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compacted history",
        description:
          "Earlier turns are preserved in a compaction checkpoint. Open session checkpoints to branch or restore that pre-compaction view.",
        action: {
          kind: "session-checkpoints",
          label: "Open checkpoints",
        },
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showToolCalls && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    const searchQuery = props.searchQuery ?? "";
    if (props.searchOpen && searchQuery.trim() && !messageMatchesSearchQuery(msg, searchQuery)) {
      continue;
    }
    if (!hasRenderableNormalizedMessage(msg) && normalized.role.toLowerCase() !== "assistant") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  for (const liftedCanvasSource of liftedCanvasSources) {
    const assistantIndex = findNearestAssistantMessageIndex(items, liftedCanvasSource.timestamp);
    if (assistantIndex == null) {
      continue;
    }
    const item = items[assistantIndex];
    if (!item || item.kind !== "message") {
      continue;
    }
    items[assistantIndex] = {
      ...item,
      message: appendCanvasBlockToAssistantMessage(
        item.message as Record<string, unknown>,
        liftedCanvasSource.preview,
        liftedCanvasSource.text,
      ),
    };
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const segments = props.streamSegments ?? [];
  const maxLen = Math.max(segments.length, tools.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < segments.length) {
      const text = sanitizeStreamText(segments[i].text);
      if (text.length > 0) {
        items.push({
          kind: "stream",
          key: `stream-seg:${props.sessionKey}:${i}`,
          text,
          startedAt: segments[i].ts,
        });
      }
    }
    if (i < tools.length && props.showToolCalls) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    const text = sanitizeStreamText(props.stream);
    if (text.length > 0) {
      if (!stripHeartbeatTokenForDisplay(text).shouldSkip) {
        items.push({
          kind: "stream",
          key,
          text,
          startedAt: props.streamStartedAt ?? Date.now(),
        });
      }
    } else if (props.stream.trim().length === 0) {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(collapseSequentialDuplicateMessages(items));
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    const role = typeof m.role === "string" ? m.role : "unknown";
    const id = typeof m.id === "string" ? m.id : "";
    if (id) {
      return `tool:${role}:${toolCallId}:${id}`;
    }
    const messageId = typeof m.messageId === "string" ? m.messageId : "";
    if (messageId) {
      return `tool:${role}:${toolCallId}:${messageId}`;
    }
    const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
    if (timestamp != null) {
      return `tool:${role}:${toolCallId}:${timestamp}:${index}`;
    }
    return `tool:${role}:${toolCallId}:${index}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
