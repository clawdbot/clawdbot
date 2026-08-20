import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { chatItemStartsUserTurn } from "./chat-turn-boundary.ts";

export type StreamRunRenderItem = {
  kind: "stream-run";
  key: string;
  runId?: string;
  parts: Array<
    Extract<ChatItem, { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" }>
  >;
};

type AgentRunPart = MessageGroup | StreamRunRenderItem;

function composableRunId(item: AgentRunPart): string | undefined {
  if (item.kind === "group" && (item.role === "assistant" || item.role === "tool")) {
    if (
      chatItemStartsUserTurn(item) ||
      item.messages.some(({ message }) => asRecord(message)?.stopReason === "error")
    ) {
      return undefined;
    }
    return item.runId;
  }
  return item.kind === "stream-run" ? item.runId : undefined;
}

function streamMessage(part: Extract<StreamRunRenderItem["parts"][number], { kind: "stream" }>) {
  return {
    key: part.key,
    message: {
      role: "assistant",
      content: [{ type: "text", text: part.text }],
      timestamp: part.startedAt,
    },
  };
}

/** Compose one authoritative run into the existing MessageGroup owner. */
export function coalesceAgentRunGroups(
  items: Array<ChatItem | MessageGroup | StreamRunRenderItem>,
): Array<ChatItem | MessageGroup | StreamRunRenderItem> {
  const result: Array<ChatItem | MessageGroup | StreamRunRenderItem> = [];
  let runId: string | undefined;
  let parts: AgentRunPart[] = [];
  const flush = () => {
    const first = parts[0];
    if (!first || !runId) {
      return;
    }
    if (parts.length === 1) {
      result.push(first);
    } else {
      const messages: MessageGroup["messages"] = [];
      const status: StreamRunRenderItem["parts"] = [];
      let assistant: MessageGroup | undefined;
      let firstGroupKey: string | undefined;
      let timestamp = Number.POSITIVE_INFINITY;
      let isStreaming = false;
      let statusKey: string | undefined;
      let hasAssistantStream = false;
      for (const part of parts) {
        if (part.kind === "group") {
          firstGroupKey ??= part.key;
          assistant ??= part.role === "assistant" ? part : undefined;
          messages.push(...part.messages);
          timestamp = Math.min(timestamp, part.timestamp);
          isStreaming ||= part.isStreaming;
          continue;
        }
        statusKey ??= part.key;
        for (const stream of part.parts) {
          timestamp = Math.min(timestamp, stream.startedAt);
          if (stream.kind === "stream") {
            messages.push(streamMessage(stream));
            hasAssistantStream = true;
            isStreaming ||= stream.isStreaming;
          } else {
            status.push(stream);
          }
        }
      }
      result.push({
        kind: "group",
        key: firstGroupKey ?? first.key,
        role: assistant || hasAssistantStream ? "assistant" : "tool",
        senderLabel: assistant?.senderLabel,
        replyToSender: assistant?.replyToSender,
        messages,
        timestamp,
        isStreaming,
        runId,
      });
      if (statusKey && status.length > 0) {
        result.push({ kind: "stream-run", key: statusKey, parts: status, runId });
      }
    }
    runId = undefined;
    parts = [];
  };
  for (const item of items) {
    if (item.kind !== "group" && item.kind !== "stream-run") {
      flush();
      result.push(item);
      continue;
    }
    const itemRunId = composableRunId(item);
    if (!itemRunId) {
      flush();
      result.push(item);
      continue;
    }
    if (runId && runId !== itemRunId) {
      flush();
    }
    runId = itemRunId;
    parts.push(item);
  }
  flush();
  return result;
}
