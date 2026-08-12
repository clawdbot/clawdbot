import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  extractToolCallContent,
  extractToolCallLocations,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper.js";

/** Gateway transcript message shape accepted by ACP replay extraction. */
export type GatewayTranscriptMessage = {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  details?: unknown;
  isError?: unknown;
};

export type GatewayChatContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

type ReplayTextChunk = {
  [Update in "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"]: {
    sessionUpdate: Update;
    text: string;
  };
}["user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"];

type ReplayChunk =
  | ReplayTextChunk
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      status: "in_progress";
      rawInput?: Record<string, unknown>;
      kind: ToolKind;
      locations?: ToolCallLocation[];
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: "completed" | "failed";
      rawOutput: { content: unknown; details?: unknown };
      content?: ToolCallContent[];
      locations?: ToolCallLocation[];
    };

function extractToolResultReplay(message: GatewayTranscriptMessage): ReplayChunk[] {
  const toolCallId = normalizeOptionalString(message.toolCallId);
  if (!toolCallId) {
    return [];
  }
  const rawOutput = {
    content: message.content,
    ...(message.details === undefined ? {} : { details: message.details }),
  };
  return [
    {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: message.isError === true ? "failed" : "completed",
      rawOutput,
      content: extractToolCallContent(message.content) ?? extractToolCallContent(rawOutput),
      locations: extractToolCallLocations(rawOutput),
    },
  ];
}

export function extractReplayChunks(message: GatewayTranscriptMessage): ReplayChunk[] {
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "toolResult") {
    return extractToolResultReplay(message);
  }
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  if (typeof message.content === "string") {
    return message.content.length > 0
      ? [
          {
            sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
            text: message.content,
          },
        ]
      : [];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }

  const replayChunks: ReplayChunk[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const typedBlock = block as GatewayChatContentBlock;
    if (typedBlock.type === "text" && typeof typedBlock.text === "string" && typedBlock.text) {
      replayChunks.push({
        sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
        text: typedBlock.text,
      });
      continue;
    }
    if (role === "assistant" && typedBlock.type === "toolCall") {
      const toolCallId = normalizeOptionalString(typedBlock.id);
      const name = normalizeOptionalString(typedBlock.name);
      if (!toolCallId) {
        continue;
      }
      const args = asOptionalRecord(typedBlock.arguments);
      replayChunks.push({
        sessionUpdate: "tool_call",
        toolCallId,
        title: formatToolTitle(name, args),
        status: "in_progress",
        rawInput: args,
        kind: inferToolKind(name),
        locations: extractToolCallLocations(args),
      });
      continue;
    }
    if (
      role === "assistant" &&
      typedBlock.type === "thinking" &&
      typeof typedBlock.thinking === "string" &&
      typedBlock.thinking
    ) {
      replayChunks.push({
        sessionUpdate: "agent_thought_chunk",
        text: typedBlock.thinking,
      });
    }
  }
  return replayChunks;
}
